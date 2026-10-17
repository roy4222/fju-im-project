import 'server-only'
import type { ResolvedActor } from '@/application/accounts'

/**
 * 登入身分快取（B 設計方案 §4.1；Q189：60 秒）。
 *
 * 同一張 session cookie 在 TTL 內再來，`DbActorResolver` 直接回上次解析好的 actor，不再跑身分 SQL。
 * 鍵是 cookie 裡那串**已簽章**的 session token（跟 Better Auth 讀的是同一個值），所以沒有 cookie 就沒有鍵，
 * 亂編的 token 簽章對不上、根本不會被存進來。
 *
 * - 項目到期＝`min(現在 + TTL, session 到期)`：session 過期後重放舊 cookie 不會命中。
 * - 會改身分的入口（登出、改／重設密碼、停用、恢復、去識別化、加撤管理員、核發臨時密碼、換頭像、老師補資料）
 *   做完就 `bustUser`／`bustToken`，下一次請求就是新資料；完整清單在契約 03 §2。
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

type Entry = {
  readonly actor: ResolvedActor
  readonly userId: string
  readonly expiresAt: number
}

export const DEFAULT_IDENTITY_CACHE_TTL_SECONDS = 60
const DEFAULT_MAX_ENTRIES = 5000

export class IdentityCache {
  readonly ttlSeconds: number
  readonly #maxEntries: number
  readonly #entries = new Map<string, Entry>()
  #generation = 0

  constructor(options: IdentityCacheOptions) {
    this.ttlSeconds = Math.max(0, options.ttlSeconds)
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  }

  get enabled(): boolean {
    return this.ttlSeconds > 0
  }

  get size(): number {
    return this.#entries.size
  }

  get(token: string, now: Date): ResolvedActor | undefined {
    const entry = this.#entries.get(token)
    if (!entry) return undefined
    if (now.getTime() >= entry.expiresAt) {
      this.#entries.delete(token)
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
   * 只存已登入的 actor（匿名沒有鍵，也不值得存）。
   */
  set(
    token: string,
    actor: ResolvedActor & { kind: 'authenticated' },
    options: { now: Date; sessionExpiresAt: Date; ticket: number },
  ): void {
    if (!this.enabled || options.ticket !== this.#generation) return
    const expiresAt = Math.min(options.now.getTime() + this.ttlSeconds * 1000, options.sessionExpiresAt.getTime())
    if (expiresAt <= options.now.getTime()) return
    this.#entries.delete(token)
    while (this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next().value
      if (oldest === undefined) break
      this.#entries.delete(oldest)
    }
    this.#entries.set(token, { actor, userId: actor.userId, expiresAt })
  }

  /** 這個人所有 cookie 的項目都丟掉。 */
  bustUser(userId: string): void {
    this.#generation += 1
    for (const [token, entry] of this.#entries) {
      if (entry.userId === userId) this.#entries.delete(token)
    }
  }

  /** 丟掉這一張 cookie 的項目（登出）。 */
  bustToken(token: string): void {
    this.#generation += 1
    this.#entries.delete(token)
  }

  /** 全部丟掉（重設密碼找不到是誰時；測試）。 */
  clear(): void {
    this.#generation += 1
    this.#entries.clear()
  }
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

let shared: IdentityCache | undefined

/** 整個程序共用的那一份（第一次用到才讀環境變數）。 */
export function getIdentityCache(): IdentityCache {
  shared ??= createIdentityCache()
  return shared
}

/** 會改身分的入口做完呼叫這個（見檔頭）。 */
export function bustIdentity(userId: string): void {
  getIdentityCache().bustUser(userId)
}
