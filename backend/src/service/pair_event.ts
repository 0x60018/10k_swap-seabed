import { hash, num, uint256 } from 'starknet'
import { PairEvent } from '../model/pair_event'
import { SnBlock } from '../model/sn_block'
import { get10kStartBlockByEnv } from '../util'
import { Core } from '../util/core'
import { accessLogger } from '../util/logger'
import { Pair, PoolService } from './pool'

const keyNames = {
  [hash.getSelectorFromName('Approval')]: 'Approval',
  [hash.getSelectorFromName('Burn')]: 'Burn',
  [hash.getSelectorFromName('Mint')]: 'Mint',
  [hash.getSelectorFromName('Swap')]: 'Swap',
  [hash.getSelectorFromName('Sync')]: 'Sync',
  [hash.getSelectorFromName('Transfer')]: 'Transfer',
}

export class PairEventService {
  private static pairCursors: { [key: string]: string } = {}

  constructor(
    private repoPairEvent = Core.db.getRepository(PairEvent),
    private repoSnBlock = Core.db.getRepository(SnBlock)
  ) {}

  async startWork() {
    if (PoolService.pairs.length < 1) {
      return
    }

    const saveWhenNoExist = async (data: any) => {
      const { transaction_index, transaction_hash, event_index } = data

      if (!transaction_hash) {
        return
      }

      const event_id = `${transaction_hash}_${event_index}`

      const one = await this.repoPairEvent.findOne({
        where: { event_id },
      })
      if (one) {
        return
      }

      const cursor = Buffer.from(
        `${transaction_hash}_${event_index}__${data.timestamp}${
          transaction_index + ''.padStart(6, '0')
        }${event_index + ''.padStart(6, '0')}`
      ).toString('base64')

      const pairEvent = new PairEvent()
      pairEvent.event_id = event_id
      pairEvent.pair_address = data.pairAddress
      pairEvent.transaction_hash = transaction_hash
      pairEvent.event_data = JSON.stringify(data.event_data)
      pairEvent.key_name = data.name
      pairEvent.block_number = data.block_number
      pairEvent.event_time = new Date(data.timestamp * 1000)
      pairEvent.cursor = cursor
      pairEvent.source_data = JSON.stringify(data)
      pairEvent.status = 0

      if (['Swap', 'Mint', 'Burn'].indexOf(pairEvent.key_name) === -1) {
        pairEvent.status = 99
      }

      return this.repoPairEvent.save(pairEvent)
    }

    const lastPairEvent = await this.repoPairEvent.findOne(undefined, {
      order: { block_number: 'DESC' },
      select: ['block_number'],
    })
    const lastSNBlock = await this.repoSnBlock.findOne({
      select: ['block_number'],
      order: { block_number: 'DESC' },
    })

    let i = lastPairEvent?.block_number || get10kStartBlockByEnv()
    for (; i <= (lastSNBlock?.block_number || 0); i++) {
      const snBlock = await this.repoSnBlock.findOne(undefined, {
        where: { block_number: i },
        order: { block_number: 'ASC' },
      })
      if (snBlock?.block_data === undefined) continue

      const transaction_receipts: {
        transaction_index: number
        transaction_hash: string
        events: { from_address: string; keys: string[]; data: any[] }[]
      }[] = snBlock.block_data['transaction_receipts']
      if (!(transaction_receipts instanceof Array)) {
        continue
      }

      const datas: any[] = []
      for (const item of transaction_receipts) {
        if (!(item.events instanceof Array)) continue

        for (const eventIndex in item.events) {
          const event = item.events[eventIndex]

          const targetPair = PoolService.pairs.find(
            (p) =>
              num.toBigInt(event.from_address) == num.toBigInt(p.pairAddress)
          )

          if (targetPair === undefined) continue

          const key = event.keys.find((k) => keyNames[k] !== undefined)
          if (key === undefined) continue

          datas.push({
            pairAddress: targetPair.pairAddress,
            event_index: eventIndex,
            transaction_index: item.transaction_index,
            transaction_hash: item.transaction_hash,
            name: keyNames[key],
            block_number: snBlock.block_data.block_number,
            event_data: event.data,
            timestamp: snBlock.block_data['timestamp'],
          })
        }
      }

      await Promise.all(datas.map((data: any) => saveWhenNoExist(data)))
    }

    // let p = 1
    // while (true) {
    //   try {
    //     const { data } = await voyagerService
    //       .getAxiosClient()
    //       .get(`/api/events?contract=${pair.pairAddress}&ps=50&p=${p}`, {
    //         headers,
    //       })

    //     const items: any[] | undefined = data?.items
    //     if (items == undefined) {
    //       throw 'undefined items!'
    //     }
    //     if (items.length <= 0) {
    //       break
    //     }

    //     await Promise.all(items.map((item: any) => saveWhenNoExist(item)))

    //     p += 1
    //   } catch (e) {
    //     errorLogger.error(`PairEvent collect failed: ${e.message}`)
    //     await sleep(1000)
    //   }
    // }
  }

  async getLpEvents(pairAddress: string, fromBlock = 0, toBlock = 0) {
    const diff = toBlock - fromBlock
    if (Number.isNaN(diff) || diff <= 0 || diff > 20000) {
      throw new Error(
        `Invalid block, fromBlock: ${fromBlock} - toBlock: ${toBlock}`
      )
    }

    const queryBuilder = this.repoPairEvent.createQueryBuilder()
    queryBuilder.select(
      'id, event_id, pair_address, transaction_hash, key_name, event_data, event_time, block_number'
    )
    if (pairAddress) {
      queryBuilder.andWhere(`pair_address = :pairAddress`, { pairAddress })
    }
    queryBuilder.andWhere(`key_name = 'Transfer'`)
    queryBuilder.andWhere('block_number BETWEEN :fromBlock AND :toBlock', {
      fromBlock,
      toBlock,
    })
    queryBuilder.orderBy('id', 'ASC')

    const events = await queryBuilder.getRawMany()

    const lpEvents: {
      id: number
      event_id: string
      pair_address: string
      transaction_hash: string
      key_name: string
      event_data: string
      event_time: string
      block_number: number
    }[] = []
    for (const event of events) {
      try {
        const eventData = JSON.parse(event.event_data)
        if (eventData.length !== 4) {
          accessLogger.warn(`Event[${event.event_id}] event_data invalid`)
          continue
        }

        const eventData0 = num.toBigInt(eventData[0])
        const eventData1 = num.toBigInt(eventData[1])
        const eventDataAmount = num.toHex(
          uint256.uint256ToBN({
            low: eventData[2],
            high: eventData[3],
          })
        )

        // Ignore pair -> zero (Burn)
        if (
          eventData0 === num.toBigInt(event.pair_address) &&
          eventData1 == 0n
        ) {
          continue
        }

        if (num.toBigInt(eventData[0]) === 0n) {
          // Mint
          event['key_name'] = 'Mint'
          event['event_data_parsed'] = {
            account: eventData[1],
            amount: eventDataAmount,
          }
        } else if (
          num.toBigInt(eventData[1]) === num.toBigInt(event.pair_address)
        ) {
          // Burn
          event['key_name'] = 'Burn'
          event['event_data_parsed'] = {
            account: eventData[0],
            amount: eventDataAmount,
          }
        } else {
          // Transfer
          event['event_data_parsed'] = {
            account: eventData[0],
            recipient: eventData[1],
            amount: eventDataAmount,
          }
        }

        event['event_data'] = eventData

        lpEvents.push(event)
      } catch (err: any) {
        accessLogger.warn(
          `Event[${event.event_id}] parse failed: ${err.message}`
        )
      }
    }

    return lpEvents
  }

  private async getAfterCursor(pair: Pair) {
    if (PairEventService.pairCursors[pair.pairAddress]) {
      return PairEventService.pairCursors[pair.pairAddress]
    }

    const pairEvent = await this.repoPairEvent.findOne({
      select: ['cursor'],
      where: { pair_address: pair.pairAddress },
      order: { event_time: 'DESC' },
    })
    return pairEvent?.cursor || ''
  }
}
