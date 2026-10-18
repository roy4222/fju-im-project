import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedActor } from '@/application/accounts'
import { getIdentityCache, IdentityCache, identityCacheTtlFromEnv, parseSessionCookie, type SessionCookie } from './identity-cache'

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
const NAME = 'better-auth.session_token'
const SECURE = '__Secure-better-auth.session_token'
/** 44 字元、`=` 結尾的假簽章（套件的格式前檢查只看這兩點）。 */
const SIG = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

/** 鍵用 `<token>.<簽章>` 的寫法；`cookie('tok-1')` 與 `cookie('tok-1', 'b')` 是同一個 session 的兩種寫法。 */
function cookie(token: string, variant = 'a'): SessionCookie {
  return { key: `${token}.${variant}${SIG.slice(1)}`, token }
}

function ready(ttlSeconds = 60, maxEntries?: number): IdentityCache {
  const cache = new IdentityCache({ ttlSeconds, ...(maxEntries === undefined ? {} : { maxEntries }) })
  cache.observeSessionCookieName(NAME)
  return cache
}

function put(cache: IdentityCache, c: SessionCookie, value: Authenticated, now = T0, sessionExpiresAt = FAR) {
  cache.set(c, value, { now, sessionExpiresAt, ticket: cache.beginLoad() })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('命中與過期', () => {
  it('TTL 內命中同一個 actor', () => {
    const cache = ready()
    const a = actor('u1')
    put(cache, cookie('tok-1'), a)
    expect(cache.get(cookie('tok-1').key, at(59))).toBe(a)
  })

  it('沒存過的鍵 miss', () => {
    const cache = ready()
    expect(cache.get('nope', T0)).toBeUndefined()
  })

  it('滿 TTL 就 miss（並清掉那一筆）', () => {
    const cache = ready()
    put(cache, cookie('tok-1'), actor('u1'))
    expect(cache.get(cookie('tok-1').key, at(60))).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  it('到期取 min(TTL, session 到期)：session 先到期就照 session', () => {
    const cache = ready()
    put(cache, cookie('tok-1'), actor('u1'), T0, at(2))
    expect(cache.get(cookie('tok-1').key, at(1))).toBeDefined()
    expect(cache.get(cookie('tok-1').key, at(2))).toBeUndefined()
  })

  it('session 已經過期的不存', () => {
    const cache = ready()
    put(cache, cookie('tok-1'), actor('u1'), T0, T0)
    expect(cache.size).toBe(0)
  })

  it('TTL 0 = 關閉：存不進去、也不讀 cookie', () => {
    const cache = ready(0)
    put(cache, cookie('tok-1'), actor('u1'))
    expect(cache.enabled).toBe(false)
    expect(cache.get(cookie('tok-1').key, T0)).toBeUndefined()
    expect(cache.sessionCookie(new Headers({ cookie: `${NAME}=tok-1.${SIG}` }))).toBeNull()
  })
})

describe('失效（次要索引：同 session 的所有寫法、同一個人的所有 session）', () => {
  it('bustUser 丟掉這個人所有 session、所有寫法，別人的不動', () => {
    const cache = ready()
    put(cache, cookie('a-1'), actor('a'))
    put(cache, cookie('a-1', 'b'), actor('a'))
    put(cache, cookie('a-2'), actor('a'))
    put(cache, cookie('b-1'), actor('b'))
    cache.bustUser('a')
    expect(cache.get(cookie('a-1').key, T0)).toBeUndefined()
    expect(cache.get(cookie('a-1', 'b').key, T0)).toBeUndefined()
    expect(cache.get(cookie('a-2').key, T0)).toBeUndefined()
    expect(cache.get(cookie('b-1').key, T0)).toBeDefined()
    expect(cache.size).toBe(1)
  })

  it('bustSession 丟掉這個 session 的每一種寫法，同一個人的其他 session 不動', () => {
    const cache = ready()
    put(cache, cookie('a-1'), actor('a'))
    put(cache, cookie('a-1', 'b'), actor('a'))
    put(cache, cookie('a-1', 'c'), actor('a'))
    put(cache, cookie('a-2'), actor('a'))
    cache.bustSession('a-1')
    expect(cache.get(cookie('a-1').key, T0)).toBeUndefined()
    expect(cache.get(cookie('a-1', 'b').key, T0)).toBeUndefined()
    expect(cache.get(cookie('a-1', 'c').key, T0)).toBeUndefined()
    expect(cache.get(cookie('a-2').key, T0)).toBeDefined()
  })

  it('bustSession 傳的是 token，不是 cookie 的鍵：拿鍵來 bust 不會清到任何東西', () => {
    const cache = ready()
    put(cache, cookie('a-1'), actor('a'))
    cache.bustSession(cookie('a-1').key)
    expect(cache.get(cookie('a-1').key, T0)).toBeDefined()
  })

  it('同一個鍵被另一個人重新存入後，舊索引不會把新項目一起清掉', () => {
    const cache = ready()
    put(cache, cookie('a-1'), actor('a'))
    put(cache, cookie('a-1'), actor('b')) // 同一個鍵換了人（理論上不會，但索引要跟著走）
    cache.bustUser('a')
    expect(cache.get(cookie('a-1').key, T0)).toMatchObject({ userId: 'b' })
  })

  it('clear 全部丟掉，索引也清空（之後同鍵再存、再 bust 仍正常）', () => {
    const cache = ready()
    put(cache, cookie('a-1'), actor('a'))
    put(cache, cookie('b-1'), actor('b'))
    cache.clear()
    expect(cache.size).toBe(0)
    put(cache, cookie('a-1'), actor('a'))
    cache.bustSession('a-1')
    expect(cache.size).toBe(0)
  })

  it('過期被 get 清掉、或被上限擠掉的項目，索引一併移除', () => {
    const cache = ready(60, 1)
    put(cache, cookie('a-1'), actor('a'))
    put(cache, cookie('a-2'), actor('a')) // 擠掉 a-1
    expect(cache.size).toBe(1)
    cache.bustSession('a-1') // 沒有東西可清，也不該丟錯
    expect(cache.get(cookie('a-2').key, T0)).toBeDefined()
    expect(cache.get(cookie('a-2').key, at(60))).toBeUndefined()
    cache.bustSession('a-2')
    expect(cache.size).toBe(0)
  })

  it('讀到一半被 bust：讀取前拿的號碼過期，舊資料不存回去', () => {
    const cache = ready()
    const ticket = cache.beginLoad()
    cache.bustUser('a') // 讀資料庫的途中系辦停用了他
    cache.set(cookie('a-1'), actor('a'), { now: T0, sessionExpiresAt: FAR, ticket })
    expect(cache.get(cookie('a-1').key, T0)).toBeUndefined()
  })

  it('bustSession 也讓途中的讀取作廢', () => {
    const cache = ready()
    const ticket = cache.beginLoad()
    cache.bustSession('a-1')
    cache.set(cookie('a-1'), actor('a'), { now: T0, sessionExpiresAt: FAR, ticket })
    expect(cache.size).toBe(0)
  })
})

describe('上限', () => {
  it('超過上限丟最舊的', () => {
    const cache = ready(60, 2)
    put(cache, cookie('t1'), actor('u1'))
    put(cache, cookie('t2'), actor('u2'))
    put(cache, cookie('t3'), actor('u3'))
    expect(cache.size).toBe(2)
    expect(cache.get(cookie('t1').key, T0)).toBeUndefined()
    expect(cache.get(cookie('t2').key, T0)).toBeDefined()
    expect(cache.get(cookie('t3').key, T0)).toBeDefined()
  })

  it('預設上限 5000 筆', () => {
    const cache = ready()
    for (let i = 0; i < 5001; i += 1) put(cache, cookie(`t${i}`), actor(`u${i}`))
    expect(cache.size).toBe(5000)
    expect(cache.get(cookie('t0').key, T0)).toBeUndefined()
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

describe('parseSessionCookie：照套件（better-call parseCookies ＋ getSignedCookie）的規則正規化', () => {
  /** 真的簽章長這樣：base64 裡有 `/`、`+`、`=`，套件 Set-Cookie 時 `encodeURIComponent` 過。 */
  const RAW_SIG = 'xOGq+5Bq4FyB1x3RbDlbfR/W2a6Rr6cD4L6IbdqhkA0='
  const TOKEN = 'JqiV2M3x5Q0gqyyUUb7g1Yb0sNQXeDmm'
  const DECODED = `${TOKEN}.${RAW_SIG}`
  const ENCODED = encodeURIComponent(DECODED)
  const parse = (header: string | null, name = NAME) => parseSessionCookie(header, name)

  it('Set-Cookie 原樣、全解碼、只解碼一部分、加引號、`.` 寫成 %2E：同一個鍵、同一個 token', () => {
    const spellings = [
      ENCODED,
      DECODED,
      DECODED.replace('=', '%3D'),
      `"${DECODED}"`,
      `"${ENCODED}"`,
      ENCODED.replace('.', '%2E'),
    ]
    for (const spelling of spellings) {
      expect(parse(`theme=dark; ${NAME}=${spelling}; other=1`), spelling).toEqual({ key: DECODED, token: TOKEN })
    }
  })

  it('同一個 token、簽章末字元 base64 可塑的寫法：鍵不同（解碼也不會一樣）、token 相同——靠次要索引一起清', () => {
    const variant = `${TOKEN}.${RAW_SIG.slice(0, 42)}1=`
    expect(parse(`${NAME}=${variant}`)).toEqual({ key: variant, token: TOKEN })
    expect(parse(`${NAME}=${variant}`)?.key).not.toBe(DECODED)
  })

  it('只認傳進來的那個名字：secure 站台只讀 __Secure- 那張，一般站台只讀一般那張', () => {
    expect(parse(`${SECURE}=${ENCODED}`, SECURE)).toEqual({ key: DECODED, token: TOKEN })
    expect(parse(`${SECURE}=${ENCODED}`, NAME)).toBeNull()
    expect(parse(`${NAME}=${ENCODED}`, SECURE)).toBeNull()
  })

  it('名字前後有空白、`;` 之間有空段、沒有 `=` 的段：跟套件一樣略過', () => {
    expect(parse(`garbage; ; ${NAME} = ${ENCODED} ;; x`)).toEqual({ key: DECODED, token: TOKEN })
  })

  it('沒有 cookie、沒有 session cookie、值是空的：null', () => {
    expect(parse(null)).toBeNull()
    expect(parse('')).toBeNull()
    expect(parse('theme=dark')).toBeNull()
    expect(parse(`${NAME}=`)).toBeNull()
    expect(parse(`${NAME}=""`)).toBeNull()
  })

  it('同名兩張（不管順序）：null（套件取第一張，我們不跟）', () => {
    expect(parse(`${NAME}=${ENCODED}; ${NAME}=other.${SIG}`)).toBeNull()
    expect(parse(`${NAME}=other.${SIG}; ${NAME}=${ENCODED}`)).toBeNull()
  })

  it('secure 與一般名稱混用、或 __Host-／`-` 分隔的寫法同時出現：null', () => {
    expect(parse(`${NAME}=${ENCODED}; ${SECURE}=other.${SIG}`)).toBeNull()
    expect(parse(`${SECURE}=other.${SIG}; ${NAME}=${ENCODED}`)).toBeNull()
    expect(parse(`${NAME}=${ENCODED}; __Host-better-auth.session_token=other.${SIG}`)).toBeNull()
    expect(parse(`${NAME}=${ENCODED}; better-auth-session_token=other.${SIG}`)).toBeNull()
    expect(parse(`${SECURE}=${ENCODED}; ${NAME}=other.${SIG}`, SECURE)).toBeNull()
  })

  it('正規化失敗：%% 解不開、沒有 `.`、token 空的、簽章長度不對或不是 `=` 結尾：null', () => {
    expect(parse(`${NAME}=${TOKEN}.${RAW_SIG.replace('+', '%ZZ')}`)).toBeNull()
    expect(parse(`${NAME}=${TOKEN}%E0%A4%A.${RAW_SIG}`)).toBeNull()
    expect(parse(`${NAME}=${TOKEN}`)).toBeNull()
    expect(parse(`${NAME}=.${RAW_SIG}`)).toBeNull()
    expect(parse(`${NAME}=${TOKEN}.${RAW_SIG.slice(1)}`)).toBeNull()
    expect(parse(`${NAME}=${TOKEN}.${RAW_SIG.slice(0, 43)}A`)).toBeNull()
  })

  it('引號只開不關：套件照樣砍掉頭尾各一個字元（簽章就少了 `=`，套件會拒絕）→ null', () => {
    expect(parse(`${NAME}="${DECODED}`)).toBeNull()
    // 砍完剛好還是合法的寫法：鍵是砍完的字串（套件拿去驗的就是它）。
    expect(parse(`${NAME}="${DECODED}=`)).toEqual({ key: DECODED, token: TOKEN })
  })
})

describe('session cookie 名稱登記（fail closed）', () => {
  it('登記前不讀 cookie；登記預期內的名字後才讀', () => {
    const cache = new IdentityCache({ ttlSeconds: 60 })
    const headers = new Headers({ cookie: `${NAME}=tok.${SIG}` })
    expect(cache.sessionCookieName).toBeNull()
    expect(cache.sessionCookie(headers)).toBeNull()
    cache.observeSessionCookieName(NAME)
    expect(cache.sessionCookieName).toBe(NAME)
    expect(cache.sessionCookie(headers)).toEqual({ key: `tok.${SIG}`, token: 'tok' })
    expect(cache.sessionCookie(new Headers({ cookie: `${SECURE}=tok.${SIG}` }))).toBeNull()
  })

  it('登記 __Secure- 的名字：只讀 __Secure- 那張', () => {
    const cache = new IdentityCache({ ttlSeconds: 60 })
    cache.observeSessionCookieName(SECURE)
    expect(cache.sessionCookie(new Headers({ cookie: `${SECURE}=tok.${SIG}` }))).toEqual({ key: `tok.${SIG}`, token: 'tok' })
    expect(cache.sessionCookie(new Headers({ cookie: `${NAME}=tok.${SIG}` }))).toBeNull()
  })

  it('套件的名字不在預期內（例如改了 cookiePrefix）：清空、永久停用、記一次 log', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const cache = new IdentityCache({ ttlSeconds: 60 })
    cache.observeSessionCookieName('fju.session_token')
    expect(cache.enabled).toBe(false)
    expect(cache.disabledReason).toContain('fju.session_token')
    expect(cache.sessionCookie(new Headers({ cookie: `fju.session_token=tok.${SIG}` }))).toBeNull()
    put(cache, cookie('tok'), actor('u1'))
    expect(cache.size).toBe(0)
    // 之後再登記正確的名字也不會復活。
    cache.observeSessionCookieName(NAME)
    expect(cache.enabled).toBe(false)
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('前後登記的名字不一致：清掉已有項目並停用', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const cache = ready()
    put(cache, cookie('tok'), actor('u1'))
    cache.observeSessionCookieName(NAME) // 同名再登記沒事
    expect(cache.size).toBe(1)
    cache.observeSessionCookieName(SECURE)
    expect(cache.enabled).toBe(false)
    expect(cache.size).toBe(0)
  })
})

describe('程序內只有一份', () => {
  it('掛在 globalThis 的 Symbol.for 鍵上：不同模組實例拿到同一份', () => {
    const cache = getIdentityCache()
    expect((globalThis as Record<symbol, unknown>)[Symbol.for('fju.identityCache')]).toBe(cache)
    expect(getIdentityCache()).toBe(cache)
  })
})
