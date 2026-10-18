import 'server-only'
import type { ResolvedActor } from '@/application/accounts'

/**
 * 登入身分快取（B 設計方案 §4.1；Q189：60 秒）。
 *
 * 同一張 session cookie 在 TTL 內再來，`DbActorResolver` 直接回上次解析好的 actor，不再跑身分 SQL。
 *
 * **鍵＝套件實際拿去驗簽的那個字串**：Better Auth 的 `/get-session` 走 better-call 的 `parseCookies` →
 * `getSignedCookie`——先 trim、去掉開頭的 `"`（連同最後一個字元）、有 `%` 就 `decodeURIComponent`，再把
 * `<token>.<簽章>` 拆開驗 HMAC。`parseSessionCookie` 照同一套規則算出那個解碼後的字串當鍵，所以 Set-Cookie 原樣
 * （`%2F`、`%3D`）、全解碼（`/`、`=`）、加引號這幾種寫法得到同一個鍵。鍵含簽章、而且只在套件剛驗過**這個字串**
 * 時才存（resolver 核對 token 相等），所以拿到 token 卻沒有簽章的人命不中、簽章錯的也命不中。
 *
 * **解碼正規化不夠，還要次要索引**：簽章是 44 字元的 base64，最後一個資料字元有 2 個自由位元，`atob` 四種寫法
 * 都解成同一組位元組、套件都認——這四種解碼後仍是不同字串。所以每筆項目另記 `sessionToken` 與 `userId`：
 * 撤一個 session（登出、撤 session）就清掉同 token 的**所有**寫法，使用者層級的失效（停用、改角色、改密碼）
 * 清掉同 userId 的所有項目。bust 一律傳 session token 或 userId，不傳 cookie 原始字串。
 *
 * **只認套件真的讀的那個名字**：`getSession` 只讀 `ctx.context.authCookies.sessionToken.name`（本專案沒改
 * `cookiePrefix`，所以是 `better-auth.session_token`，HTTPS 站台前面多 `__Secure-`）。名字由 `auth-instance.ts`
 * 的 `hooks.after` 每次呼叫 `observeSessionCookieName` 登記（每一次未命中的 `getSession` 都經過那裡，所以第一筆存進來
 * 之前名字已經確定）；登記前不讀不存，登記到預期以外的名字、或前後不一致，快取永久停用並記 log（fail closed）。
 *
 * - 項目到期＝`min(現在 + TTL, session 到期)`：session 過期後重放舊 cookie 不會命中。
 * - 會改身分的入口（登出、改／重設密碼、停用、恢復、去識別化、加撤管理員、核發臨時密碼、換頭像、老師補資料）
 *   做完就 `bustUser`／`bustSession`，下一次請求就是新資料；完整清單在契約 03 §2。
 * - 沒經過那些入口、直接改資料庫的（worker、SQL），最多 TTL 秒後生效（Q189 接受）。
 * - **程序內**：只適用單一 app 程序（compose 裡一個 standalone 容器）；多副本時要換共用快取。
 *
 * 讀到一半被 bust 的競態：resolver 開始讀資料庫前先拿 `beginLoad()` 的號碼，存進來時號碼已經過期
 * （中間有人 bust 過）就不存——不然會把 bust 之前讀到的舊身分存回去，撐滿一整個 TTL。
 */

export type IdentityCacheOptions = {
  /** 秒；0 表示關閉（`get` 永遠 miss、`set` 不存）。 */
  readonly ttlSeconds: number
  /** 最多幾筆，超過丟最舊的。 */
  readonly maxEntries?: number
}

/** 一張 session cookie 照套件規則解析後的樣子：`key` 是套件拿去驗簽的整個字串（含簽章），`token` 是 `.` 之前的部分。 */
export type SessionCookie = {
  readonly key: string
  readonly token: string
}

type Entry = {
  readonly actor: ResolvedActor
  readonly userId: string
  readonly sessionToken: string
  readonly expiresAt: number
}

export const DEFAULT_IDENTITY_CACHE_TTL_SECONDS = 60
const DEFAULT_MAX_ENTRIES = 5000

/** 套件預設的 session cookie 名稱（本專案沒改 `cookiePrefix`）；HTTPS 站台是 `__Secure-` 那個。 */
export const EXPECTED_SESSION_COOKIE_NAMES: ReadonlySet<string> = new Set([
  'better-auth.session_token',
  '__Secure-better-auth.session_token',
])

/**
 * 套件 `getSessionCookie` helper 認得的所有 session cookie 寫法（端點只讀上面那一個，但標頭裡同時出現任何一種
 * 其他寫法就當歧義：不讀不存，交給套件自己挑）。
 */
const SESSION_COOKIE_VARIANTS: ReadonlySet<string> = new Set([
  'better-auth.session_token',
  '__Secure-better-auth.session_token',
  '__Host-better-auth.session_token',
  'better-auth-session_token',
  '__Secure-better-auth-session_token',
  '__Host-better-auth-session_token',
])

export class IdentityCache {
  readonly ttlSeconds: number
  readonly #maxEntries: number
  readonly #entries = new Map<string, Entry>()
  readonly #bySession = new Map<string, Set<string>>()
  readonly #byUser = new Map<string, Set<string>>()
  #generation = 0
  #cookieName: string | null = null
  #disabledReason: string | null = null

  constructor(options: IdentityCacheOptions) {
    this.ttlSeconds = Math.max(0, options.ttlSeconds)
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  }

  /** TTL 大於 0 而且沒有因為 cookie 名稱不對被停用。 */
  get enabled(): boolean {
    return this.ttlSeconds > 0 && this.#disabledReason === null
  }

  /** 被停用的原因（cookie 名稱對不上）；正常是 `null`。 */
  get disabledReason(): string | null {
    return this.#disabledReason
  }

  /** 套件登記過的 session cookie 名稱；還沒登記是 `null`（這時不讀不存）。 */
  get sessionCookieName(): string | null {
    return this.#cookieName
  }

  get size(): number {
    return this.#entries.size
  }

  /**
   * 套件每次跑 `hooks.after` 都把它實際讀的 session cookie 名稱登記進來。
   * 預期以外的名字、或前後不一致 → 清空並永久停用（fail closed），只記一次 log。
   */
  observeSessionCookieName(name: string): void {
    if (this.#disabledReason !== null) return
    if (this.#cookieName === name) return
    if (this.#cookieName === null && EXPECTED_SESSION_COOKIE_NAMES.has(name)) {
      this.#cookieName = name
      return
    }
    this.#disabledReason =
      this.#cookieName === null
        ? `套件的 session cookie 名稱是 ${JSON.stringify(name)}，不在快取預期的名單內`
        : `套件的 session cookie 名稱從 ${JSON.stringify(this.#cookieName)} 變成 ${JSON.stringify(name)}`
    this.clear()
    console.error(`identity cache: disabled（${this.#disabledReason}）`)
  }

  /** 這次請求的 session cookie（套件登記名字之前、或有歧義、或解析失敗都回 `null`）。 */
  sessionCookie(headers: Headers): SessionCookie | null {
    if (!this.enabled || this.#cookieName === null) return null
    return parseSessionCookie(headers.get('cookie'), this.#cookieName)
  }

  get(key: string, now: Date): ResolvedActor | undefined {
    const entry = this.#entries.get(key)
    if (!entry) return undefined
    if (now.getTime() >= entry.expiresAt) {
      this.#delete(key)
      return undefined
    }
    return entry.actor
  }

  /** 開始一次未命中的讀取；把回傳的號碼交給 `set`。 */
  beginLoad(): number {
    return this.#generation
  }

  /**
   * 存一筆。`ticket` 是讀取前 `beginLoad()` 拿到的號碼；中間有任何 bust 就不存。
   * 只存已登入的 actor（匿名沒有鍵，也不值得存）。呼叫端要先確認 `cookie.token` 就是套件剛驗過的 session token。
   */
  set(
    cookie: SessionCookie,
    actor: ResolvedActor & { kind: 'authenticated' },
    options: { now: Date; sessionExpiresAt: Date; ticket: number },
  ): void {
    if (!this.enabled || options.ticket !== this.#generation) return
    const expiresAt = Math.min(options.now.getTime() + this.ttlSeconds * 1000, options.sessionExpiresAt.getTime())
    if (expiresAt <= options.now.getTime()) return
    this.#delete(cookie.key)
    while (this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next().value
      if (oldest === undefined) break
      this.#delete(oldest)
    }
    this.#entries.set(cookie.key, { actor, userId: actor.userId, sessionToken: cookie.token, expiresAt })
    index(this.#bySession, cookie.token, cookie.key)
    index(this.#byUser, actor.userId, cookie.key)
  }

  /** 這個人所有 session、所有寫法的項目都丟掉（停用、改角色、改密碼、撤全部 session……）。 */
  bustUser(userId: string): void {
    this.#generation += 1
    for (const key of this.#byUser.get(userId) ?? []) this.#delete(key)
  }

  /** 這一個 session（不論 cookie 用哪一種寫法）的項目都丟掉（登出、撤單一 session）。 */
  bustSession(sessionToken: string): void {
    this.#generation += 1
    for (const key of this.#bySession.get(sessionToken) ?? []) this.#delete(key)
  }

  /** 全部丟掉（重設密碼找不到是誰時；測試）。 */
  clear(): void {
    this.#generation += 1
    this.#entries.clear()
    this.#bySession.clear()
    this.#byUser.clear()
  }

  #delete(key: string): void {
    const entry = this.#entries.get(key)
    if (!entry) return
    this.#entries.delete(key)
    unindex(this.#bySession, entry.sessionToken, key)
    unindex(this.#byUser, entry.userId, key)
  }
}

function index(map: Map<string, Set<string>>, by: string, key: string): void {
  const keys = map.get(by)
  if (keys) keys.add(key)
  else map.set(by, new Set([key]))
}

function unindex(map: Map<string, Set<string>>, by: string, key: string): void {
  const keys = map.get(by)
  if (!keys) return
  keys.delete(key)
  if (keys.size === 0) map.delete(by)
}

/**
 * 照 better-call `parseCookies` ＋ `getSignedCookie` 的規則（套件 `/get-session` 實際走的那條）解析 `name` 這張 cookie：
 * 以 `;` 切段、`=` 前後各 trim、值以 `"` 開頭就去掉頭尾各一個字元（套件就是 `slice(1, -1)`，不管尾字元是什麼）、
 * 含 `%` 就 `decodeURIComponent`，再從最後一個 `.` 拆成 `<token>.<簽章>`，簽章要剛好 44 字元且以 `=` 結尾。
 *
 * 回 `null`（不讀不存）的情況：沒有這張 cookie；同名出現不只一次（套件取第一張，我們不跟）；標頭裡同時有其他
 * session cookie 寫法（`__Secure-`／`__Host-`／`-` 分隔）；值是空的；`%` 解不開（套件會用原字串，但那樣簽章一定不過）；
 * 沒有 `.`、token 是空的、簽章長度不對。凡套件會拒絕的，這裡也拒絕；凡這裡接受的，鍵就是套件會拿去驗的那個字串。
 */
export function parseSessionCookie(header: string | null, name: string): SessionCookie | null {
  if (!header) return null
  let raw: string | null = null
  for (const chunk of header.split(';')) {
    const eq = chunk.indexOf('=')
    if (eq === -1) continue
    const key = chunk.slice(0, eq).trim()
    if (key === name) {
      if (raw !== null) return null
      raw = chunk.slice(eq + 1).trim()
    } else if (SESSION_COOKIE_VARIANTS.has(key)) {
      return null
    }
  }
  if (raw === null) return null
  let value = raw
  if (value.codePointAt(0) === 34) value = value.slice(1, -1)
  if (value.includes('%')) {
    try {
      value = decodeURIComponent(value)
    } catch {
      return null
    }
  }
  const dot = value.lastIndexOf('.')
  if (dot < 1) return null
  const signature = value.slice(dot + 1)
  if (signature.length !== 44 || !signature.endsWith('=')) return null
  return { key: value, token: value.slice(0, dot) }
}

/**
 * `IDENTITY_CACHE_TTL_SECONDS`：沒設或空字串用 60；`0` 關閉；e2e 與 CI 的 e2e job 設 0（§4.2）。
 * 測試執行器（`NODE_ENV=test`）沒設時是 0：既有整合測試直接改資料庫再立刻 resolve，
 * 要測快取的整合測試自己設 60。
 */
export function identityCacheTtlFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env.IDENTITY_CACHE_TTL_SECONDS?.trim()
  if (!raw) return env.NODE_ENV === 'test' ? 0 : DEFAULT_IDENTITY_CACHE_TTL_SECONDS
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds) : DEFAULT_IDENTITY_CACHE_TTL_SECONDS
}

function createIdentityCache(): IdentityCache {
  const cache = new IdentityCache({ ttlSeconds: identityCacheTtlFromEnv() })
  console.info(cache.enabled ? `identity cache: ttl ${cache.ttlSeconds}s` : 'identity cache: disabled')
  return cache
}

/**
 * 放在 `globalThis`，不是模組變數：Next 會把同一個模組分別打包進 Route Handler（`/api/auth/*`）與 RSC 頁面，
 * 各有一份模組實例。模組變數的話，HTTP 登出清的是 Route Handler 那份，頁面讀的那份還在，舊 cookie 照樣進得了頁面。
 * 用 `Symbol.for` 當鍵，整個程序只有一份。
 */
const SHARED = Symbol.for('fju.identityCache')
const holder = globalThis as typeof globalThis & { [SHARED]?: IdentityCache }

/** 整個程序共用的那一份（第一次用到才讀環境變數）。 */
export function getIdentityCache(): IdentityCache {
  holder[SHARED] ??= createIdentityCache()
  return holder[SHARED]
}

/** 會改身分的入口做完呼叫這個（見檔頭）：傳 userId，不傳 cookie。 */
export function bustIdentity(userId: string): void {
  getIdentityCache().bustUser(userId)
}
