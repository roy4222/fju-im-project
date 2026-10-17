import { describe, expect, it } from 'vitest'
import { poolConfigFromEnv } from '@/infrastructure/db/client'

const url = 'postgres://fju_app@localhost:5432/fju'

describe('poolConfigFromEnv', () => {
  it('沒設 DB_POOL_MAX 時上限 10，並帶 idle／連線逾時', () => {
    expect(poolConfigFromEnv({ DATABASE_URL: url })).toEqual({
      connectionString: url,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    })
  })

  it('DB_POOL_MAX 決定上限（worker 容器設 2）', () => {
    expect(poolConfigFromEnv({ DATABASE_URL: url, DB_POOL_MAX: '2' }).max).toBe(2)
    expect(poolConfigFromEnv({ DATABASE_URL: url, DB_POOL_MAX: ' 3 ' }).max).toBe(3)
  })

  it('DB_POOL_MAX 是空字串視同沒設', () => {
    expect(poolConfigFromEnv({ DATABASE_URL: url, DB_POOL_MAX: '' }).max).toBe(10)
  })

  it.each(['0', '-1', '2.5', 'abc', '10x'])('DB_POOL_MAX=%s 不是正整數就直接報錯', (value) => {
    expect(() => poolConfigFromEnv({ DATABASE_URL: url, DB_POOL_MAX: value })).toThrow('DB_POOL_MAX')
  })

  it('缺 DATABASE_URL 報錯', () => {
    expect(() => poolConfigFromEnv({})).toThrow('缺少 DATABASE_URL')
  })
})
