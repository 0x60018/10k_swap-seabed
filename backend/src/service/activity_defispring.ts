import axios from 'axios'
import dayjs from 'dayjs'
import { BigNumber } from 'ethers'
import { BigNumberish } from 'starknet'
import { MoreThan } from 'typeorm'
import { ActivityDefispring } from '../model/activity_defispring'
import { PairTransfer } from '../model/pair_transfer'
import { equalBN } from '../util'
import { Core } from '../util/core'

type AccountHValue = Record<
  string,
  {
    balanceOf: BigNumberish
    partition: BigNumberish
    lastTime: number
  }
>

const activityStartTime = 1708560000000 // Start: 2024-02-22 00:00:00(UTC-0)
const activityEndTime = 1715904000000 // End: 2024-05-17 00:00:00(UTC-0)

// const activityStartTime = 1664582400000 // Start: 2022-10-01 00:00:00(UTC-0) //TODO
// const activityEndTime = 1664582400000 + 86400 * 20 * 1000 // End: 2022-10-20 00:00:00(UTC-0) //TODO

export class ActivityDefispringService {
  public static qaSTRKGrant?: Record<
    | 'Ekubo'
    | 'MySwap'
    | 'Haiko'
    | '10kSwap'
    | 'StarkDefi'
    | 'Sithswap'
    | 'Nostra'
    | 'Jediswap_v1',
    Record<
      'USDC/USDT' | 'STRK/ETH' | 'ETH/USDC' | 'STRK/USDC',
      {
        date: string
        allocation: number
        thirty_day_realized_volatility: number
        tvl_usd: number
        apr: number
      }
    >
  > = undefined

  private accountHKey = 'ActivityDefispring_AccountH'

  constructor(
    private repoPairTransfer = Core.db.getRepository(PairTransfer),
    private repoActivityDefispring = Core.db.getRepository(ActivityDefispring),
    private activityCurrentTime = activityStartTime
  ) {}

  async startStatistics() {
    await Core.redis.del(this.accountHKey)

    let lastId = 0
    let lastPairTransfer: PairTransfer | undefined = undefined

    while (true) {
      const transfers = await this.repoPairTransfer.find({
        where: { id: MoreThan(lastId) },
        order: { event_time: 'ASC', id: 'ASC' },
        take: 20000,
      })

      if (transfers.length <= 0) break

      for (const item of transfers) {
        if (new Date(item.event_time).getTime() > activityEndTime) {
          break
        }

        if (
          this.activityCurrentTime >
            new Date(lastPairTransfer?.event_time || 0).getTime() &&
          this.activityCurrentTime <= new Date(item.event_time).getTime()
        ) {
          await this.gatherAccounts()

          this.activityCurrentTime = this.activityCurrentTime + 86400000
        }

        // Filter
        if (equalBN(item.from_address, item.token_address)) continue
        if (equalBN(item.from_address, item.recipient_address)) continue

        // Mint
        if (
          equalBN(item.from_address, 0) &&
          !equalBN(item.recipient_address, 0)
        ) {
          await this.mint(
            item.token_address,
            item.recipient_address,
            item.amount,
            item.event_time
          )
          continue
        }

        // Burn
        if (
          !equalBN(item.from_address, 0) &&
          equalBN(item.recipient_address, item.token_address)
        ) {
          await this.burn(
            item.token_address,
            item.from_address,
            item.amount,
            item.event_time
          )
          continue
        }

        // Transfer
        await this.transfer(
          item.token_address,
          item.from_address,
          item.recipient_address,
          item.amount,
          item.event_time
        )

        lastPairTransfer = item
      }

      lastId = transfers[transfers.length - 1].id
    }
  }

  async cacheQaSTRKGrant() {
    const { data, status } = await axios.get(
      'https://kx58j6x5me.execute-api.us-east-1.amazonaws.com//starknet/fetchFile?file=qa_strk_grant.json'
    )

    if (status == 200 && data) ActivityDefispringService.qaSTRKGrant = data
  }

  private async gatherAccounts() {
    const day = dayjs(this.activityCurrentTime).format('YYYY-MM-DD')

    let cursor = '0'
    while (true) {
      const [_cursor, _kvs] = await Core.redis.hscan(
        this.accountHKey,
        cursor,
        'COUNT',
        100
      )
      cursor = _cursor

      const accounts: [string, AccountHValue][] = []
      for (let index = 0; index < _kvs.length; index += 2) {
        accounts.push([_kvs[index], JSON.parse(_kvs[index + 1])])
      }

      await Promise.all(
        accounts.map(async (item) => {
          for (const pairAddress in item[1]) {
            const one = await this.repoActivityDefispring.findOne(
              { account_address: item[0], pair_address: pairAddress, day },
              {
                select: ['id'],
              }
            )
            if (one) {
              await this.repoActivityDefispring.update(one.id, {
                balance_of: item[1][pairAddress].balanceOf + '',
                partition: item[1][pairAddress].partition + '',
              })
            } else {
              await this.repoActivityDefispring.insert({
                pair_address: pairAddress,
                account_address: item[0],
                balance_of: item[1][pairAddress].balanceOf + '',
                partition: item[1][pairAddress].partition + '',
                day,
              })
            }

            item[1][pairAddress].partition =
              BigNumber.from(item[1][pairAddress].balanceOf).mul(86400) + ''
          }

          await Core.redis.hset(
            this.accountHKey,
            item[0],
            JSON.stringify(item[1])
          )
        })
      )

      if (cursor == '0') break
    }
  }

  private async mint(
    tokenAddress: string,
    account: string,
    amount: BigNumberish,
    eventTime: Date
  ) {
    const value = await Core.redis.hget(this.accountHKey, account)
    const accountCache: AccountHValue = value ? JSON.parse(value) : {}
    const lastTime = new Date(eventTime).getTime()

    const plusPartition = BigNumber.from(amount).mul(
      parseInt((this.activityCurrentTime - lastTime) / 1000 + '')
    )

    accountCache[tokenAddress] = {
      balanceOf:
        BigNumber.from(accountCache[tokenAddress]?.balanceOf || 0).add(amount) +
        '',
      partition:
        BigNumber.from(accountCache[tokenAddress]?.partition || 0).add(
          plusPartition
        ) + '',
      lastTime,
    }

    await Core.redis.hset(
      this.accountHKey,
      account,
      JSON.stringify(accountCache)
    )
  }

  private async burn(
    tokenAddress: string,
    account: string,
    amount: BigNumberish,
    eventTime: Date
  ) {
    const value = await Core.redis.hget(this.accountHKey, account)
    const accountCache: AccountHValue = value ? JSON.parse(value) : {}
    const lastTime = new Date(eventTime).getTime()

    const subPartition = BigNumber.from(amount).mul(
      parseInt((this.activityCurrentTime - lastTime) / 1000 + '')
    )

    accountCache[tokenAddress] = {
      balanceOf:
        BigNumber.from(accountCache[tokenAddress]?.balanceOf || 0).sub(amount) +
        '',
      partition:
        BigNumber.from(accountCache[tokenAddress]?.partition || 0).sub(
          subPartition
        ) + '',
      lastTime,
    }

    await Core.redis.hset(
      this.accountHKey,
      account,
      JSON.stringify(accountCache)
    )
  }

  private async transfer(
    tokenAddress: string,
    fromAccount: string,
    recipientAccount: string,
    amount: BigNumberish,
    eventTime: Date
  ) {
    await this.burn(tokenAddress, fromAccount, amount, eventTime)
    await this.mint(tokenAddress, recipientAccount, amount, eventTime)
  }
}