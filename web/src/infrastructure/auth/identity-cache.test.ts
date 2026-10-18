import { describe, expect, it } from 'vitest'
import type { ResolvedActor } from '@/application/accounts'
import { getIdentityCache, IdentityCache, identityCacheTtlFromEnv, keyMatchesSession, sessionCacheKey } from './identity-cache'

/** 身分快取本身（B 設計方案 §4.1、§4.2）：假時鐘，全部用明確的 `now`。 */

type Authenticated = ResolvedActor & { kind: 'authenticated' }

function actor(userId: string, extra: Partial<Authenticated> = {}): Authenticated {
  return {
    kind: 'authenticated',
    userId,
    roles: ['student'],
    status: 'active',
    mustChangePassword: false,
    cohortMemberships: [],
    ...extra,
  }
}

const T0 = new Date('2026-10-18T00:00:00Z')
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000)
const FAR = at(7 * 24 * 3600)

function put(cache: IdentityCache, token: string, value: Authenticated, now = T0, sessionExpiresAt = FAR) {
  cache.set(token, value, { now, sessionExpiresAt, ticket: cache.beginLoad() })
}

describe('命中與過期', () => {
  it('TTL 內命中同一個 actor', () => {
    const cache = new IdentityCache({ ttlSeconds: 60 })
    const a = actor('u1')
    put(cache, 'tok-1', a)
    expect(cache.get('tok-1', at(59))).toBe(a)
  })

  it('沒存過的 token miss', () => {
    const cache = new IdentityCache({ ttlSeconds: 60 })
    expect(cache.get('nope', T0)).toBeUndefined()
  })

  it('滿 TTL 就 miss（並清掉那一筆）', () => {
    const cache = new IdentityCache({ ttlSeconds: 60 })
    put(cache, 'tok-1', actor('u1'))
    expect(cache.get('tok-1', at(60))).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  it('到期取 min(TTL, session 到期)：session 先到期就照 session', () => {
    const cache = new IdentityCache({ ttlSeconds: 60 })
    put(cache, 'tok-1', actor('u1'), T0, at(2))
    expect(cache.get('tok-1', at(1))).toBeDefined()
    expect(cache.get('tok-1', at(2))).toBeUndefined()
  })

  it('session 已經過期的不存', () => {
    const cache = new IdentityCache({ ttlSeconds: 60 })
    put(cache, 'tok-1', actor('u1'), T0, T0)
    expect(cache.size).toBe(0)
  })

  it('TTL 0 = 關閉：存不進去', () => {
    const cache = new IdentityCache({ ttlSeconds: 0 })
    put(cache, 'tok-1', actor('u1'))
    expect(cache.enabled).toBe(false)
    expect(cache.get('tok-1', T0)).toBeUndefined()
  })
})

describe('失效', () => {
  it('bustUser 丟掉這個人所有 cookie，別人的不動', () => {
    const cache = new IdentityCache({ ttlSeconds: 60 })
    put(cache, 'a-1', actor('a'))
    put(cache, 'a-2', actor('a'))
    put(cache, 'b-1', actor('b'))
    cache.bustUser('a')
    expect(cache.get('a-1', T0)).toBeUndefined()
    expect(cache.get('a-2', T0)).toBeUndefined()
    expect(cache.get('b-1', T0)).toBeDefined()
  })

  it('bustToken 只丟那一張 cookie', () => {
    const cache = new IdentityCache({ ttlSeconds: 60 })
    put(cache, 'a-1', actor('a'))
    put(cache, 'a-2', actor('a'))
    cache.bustToken('a-1')
    expect(cache.get('a-1', T0)).toBeUndefined()
    expect(cache.get('a-2', T0)).toBeDefined()
  })

  it('clear 全部丟掉', () => {
    const cache = new IdentityCache({ ttlSeconds: 60 })
    put(cache, 'a-1', actor('a'))
    put(cache, 'b-1', actor('b'))
    cache.clear()
    expect(cache.size).toBe(0)
  })

  it('讀到一半被 bust：讀取前拿的號碼過期，舊資料不存回去', () => {
    const cache = new IdentityCache({ ttlSeconds: 60 })
    const ticket = cache.beginLoad()
    cache.bustUser('a') // 讀資料庫的途中系辦停用了他
    cache.set('a-1', actor('a'), { now: T0, sessionExpiresAt: FAR, ticket })
    expect(cache.get('a-1', T0)).toBeUndefined()
  })
})

describe('上限', () => {
  it('超過上限丟最舊的', () => {
    const cache = new IdentityCache({ ttlSeconds: 60, maxEntries: 2 })
    put(cache, 't1', actor('u1'))
    put(cache, 't2', actor('u2'))
    put(cache, 't3', actor('u3'))
    expect(cache.size).toBe(2)
    expect(cache.get('t1', T0)).toBeUndefined()
    expect(cache.get('t2', T0)).toBeDefined()
    expect(cache.get('t3', T0)).toBeDefined()
  })

  it('預設上限 5000 筆', () => {
    const cache = new IdentityCache({ ttlSeconds: 60 })
    for (let i = 0; i < 5001; i += 1) put(cache, `t${i}`, actor(`u${i}`))
    expect(cache.size).toBe(5000)
    expect(cache.get('t0', T0)).toBeUndefined()
  })
})

describe('IDENTITY_CACHE_TTL_SECONDS', () => {
  it('沒設或空字串用 60（正式）', () => {
    expect(identityCacheTtlFromEnv({ NODE_ENV: 'production' })).toBe(60)
    expect(identityCacheTtlFromEnv({ NODE_ENV: 'production', IDENTITY_CACHE_TTL_SECONDS: '' })).toBe(60)
  })

  it('0 關閉、數字照用', () => {
    expect(identityCacheTtlFromEnv({ IDENTITY_CACHE_TTL_SECONDS: '0' })).toBe(0)
    expect(identityCacheTtlFromEnv({ IDENTITY_CACHE_TTL_SECONDS: '30' })).toBe(30)
  })

  it('亂寫退回 60', () => {
    expect(identityCacheTtlFromEnv({ IDENTITY_CACHE_TTL_SECONDS: 'abc' })).toBe(60)
    expect(identityCacheTtlFromEnv({ IDENTITY_CACHE_TTL_SECONDS: '-5' })).toBe(60)
  })

  it('測試執行器沒設時是 0（既有整合測試直接改資料庫）', () => {
    expect(identityCacheTtlFromEnv({ NODE_ENV: 'test' })).toBe(0)
    expect(identityCacheTtlFromEnv({ NODE_ENV: 'test', IDENTITY_CACHE_TTL_SECONDS: '60' })).toBe(60)
  })
})

describe('快取鍵（sessionCacheKey）：只有一張 session cookie 才用快取', () => {
  const NAME = 'better-auth.session_token'
  const SECURE = '__Secure-better-auth.session_token'
  const key = (cookie: string) => sessionCacheKey(new Headers({ cookie }))

  it('只有一張：鍵是「名字=原始值」', () => {
    expect(key(`theme=dark; ${NAME}=tokB.sig%2B; other=1`)).toBe(`${NAME}=tokB.sig%2B`)
    expect(key(`${SECURE}=tokA.sig`)).toBe(`${SECURE}=tokA.sig`)
  })

  it('同一個值、不同名字是不同的鍵', () => {
    expect(key(`${NAME}=tokA.sig`)).not.toBe(key(`${SECURE}=tokA.sig`))
  })

  it('沒有 cookie、沒有 session cookie、值是空的：null', () => {
    expect(sessionCacheKey(new Headers())).toBeNull()
    expect(key('theme=dark')).toBeNull()
    expect(key(`${NAME}=`)).toBeNull()
  })

  it('同名兩張（不管順序）：null', () => {
    expect(key(`${NAME}=tokB.sig; ${NAME}=tokA.sig`)).toBeNull()
    expect(key(`${NAME}=tokA.sig; ${NAME}=tokB.sig`)).toBeNull()
  })

  it('secure 與一般名稱混用、或 __Host-／`-` 分隔的寫法同時出現：null', () => {
    expect(key(`${NAME}=tokB.sig; ${SECURE}=tokA.sig`)).toBeNull()
    expect(key(`${SECURE}=tokA.sig; ${NAME}=tokB.sig`)).toBeNull()
    expect(key(`${NAME}=tokB.sig; __Host-better-auth.session_token=tokA.sig`)).toBeNull()
    expect(key(`${NAME}=tokB.sig; better-auth-session_token=tokA.sig`)).toBeNull()
  })

  it('keyMatchesSession：值要以「剛驗過的 token.」開頭', () => {
    expect(keyMatchesSession(`${NAME}=tokA.sig`, 'tokA')).toBe(true)
    expect(keyMatchesSession(`${NAME}=tokA.sig`, 'tokB')).toBe(false)
    expect(keyMatchesSession(`${NAME}=tokAB.sig`, 'tokA')).toBe(false)
  })
})

describe('程序內只有一份', () => {
  it('掛在 globalThis 的 Symbol.for 鍵上：不同模組實例拿到同一份', () => {
    const cache = getIdentityCache()
    expect((globalThis as Record<symbol, unknown>)[Symbol.for('fju.identityCache')]).toBe(cache)
    expect(getIdentityCache()).toBe(cache)
  })
})
