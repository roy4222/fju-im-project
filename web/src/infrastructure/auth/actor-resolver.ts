import 'server-only'
import { and, eq, isNull } from 'drizzle-orm'
import {
  ANONYMOUS,
  type AccountStatus,
  type ActorResolver,
  type ResolvedActor,
  type Role,
} from '@/application/accounts'
import { teacherNeedsSetup } from '@/infrastructure/accounts/teacher-setup'
import { getDb, getPool } from '@/infrastructure/db/client'
import { roleAssignments, userProfiles, users } from '@/infrastructure/db/schema'
import { getIdentityCache, type IdentityCache } from '@/infrastructure/auth/identity-cache'
import { getSessionFromHeaders } from '@/infrastructure/auth/wrapper'

type Authenticated = ResolvedActor & { kind: 'authenticated' }

/**
 * 把「這次請求的 cookie」變成「現在是誰」（模組 01 §5）。
 *
 * 關鍵取捨：**狀態回資料庫讀**，不信 session cookie 裡帶的內容。
 * Better Auth 的 session 物件上雖然有 `user.status`，但那是登入當下的快照；
 * 系辦在那之後把人停用的話，快照還是舊的。`cookieCache` 已經關掉（S01-02），
 * 這裡再重讀一次 `users`。
 *
 * 身分快取（B 設計方案 §4.1，Q189）：同一張 cookie 在 TTL（預設 60 秒）內再來，直接回上次讀到的結果，0 句 SQL。
 * 停用、撤角色這類經過系辦畫面的改動會 bust（`identity-cache.ts`），下一次請求就生效；
 * 直接改資料庫的最多 TTL 秒後生效。
 *
 * 角色來自 `role_assignments` 目前有效的列（`revoked_real_at IS NULL`），
 * 不是 Better Auth admin plugin 的 `users.role`——那是套件自己的欄位，不是業務角色。
 */
export class DbActorResolver implements ActorResolver {
  readonly #cache: () => IdentityCache
  readonly #now: () => Date

  /** 不給 `cache` 就用整個程序共用的那份；`now` 是給整合測試撥時鐘用的。 */
  constructor(options: { cache?: IdentityCache; now?: () => Date } = {}) {
    const cache = options.cache
    this.#cache = cache ? () => cache : getIdentityCache
    this.#now = options.now ?? (() => new Date())
  }

  async resolve(headers: Headers): Promise<ResolvedActor> {
    const cache = this.#cache()
    // 鍵是那張 session cookie 照套件規則解碼後的整個字串（含簽章）；沒有、有歧義（同名多張、secure 與一般混用）、
    // 解析失敗、或套件還沒登記 cookie 名稱，就不用快取。
    let cookie = cache.sessionCookie(headers)
    if (cookie) {
      const hit = cache.get(cookie.key, this.#now())
      if (hit) return hit
    }

    const ticket = cache.beginLoad()
    const loaded = await this.#load(headers)
    if (loaded.session) {
      // 程序的第一次：套件的 `hooks.after` 在這次 `getSession` 途中才登記 cookie 名稱，所以再解析一次。
      cookie ??= cache.sessionCookie(headers)
      // 確認「套件剛驗過的就是這張 cookie」才存：解碼後的 token 要跟套件驗簽後回的 session token 一模一樣。
      if (cookie && cookie.token === loaded.session.token) {
        cache.set(cookie, loaded.actor, { now: this.#now(), sessionExpiresAt: loaded.session.expiresAt, ticket })
      }
    }
    return loaded.actor
  }

  async #load(
    headers: Headers,
  ): Promise<{ actor: ResolvedActor; session?: undefined } | { actor: Authenticated; session: { token: string; expiresAt: Date } }> {
    // `/get-session` 本身已經受帳號狀態矩陣管（S01-02 的 hook）：停用或去識別化的人
    // 會被擋成 UNAUTHENTICATED。那對這裡來說就是「沒有有效登入」，不是錯誤，
    // 所以吞掉例外回 ANONYMOUS——契約 03 §2 的「disabled 一律當作未登入」。
    let session: Awaited<ReturnType<typeof getSessionFromHeaders>> = null
    try {
      session = await getSessionFromHeaders(headers)
    } catch {
      return { actor: ANONYMOUS }
    }
    if (!session?.user?.id) return { actor: ANONYMOUS }

    const db = getDb()
    const [row] = await db
      .select({
        id: users.id,
        status: users.status,
        mustChangePassword: users.mustChangePassword,
        deidentifiedAt: users.deidentifiedAt,
        cohortId: userProfiles.cohortId,
        // 外殼頭像的姓名（同一列、同一次查詢，不另外讀；只讀 session 本人這一列）。
        name: users.name,
        displayName: userProfiles.displayName,
        // 帳號選單的頭像也在同一句讀（SH-8），不另查。
        avatarPreset: userProfiles.avatarPreset,
        avatarFileId: userProfiles.avatarFileId,
      })
      .from(users)
      .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
      .where(eq(users.id, session.user.id))
      .limit(1)

    // session 還在但人已經不在（去識別化把列留著，但這裡讀不到就當未登入）。
    if (!row) return { actor: ANONYMOUS }

    const assignments = await db
      .select({ role: roleAssignments.role })
      .from(roleAssignments)
      .where(and(eq(roleAssignments.userId, row.id), isNull(roleAssignments.revokedRealAt)))

    const roles = assignments.map((a) => a.role as Role)
    // 這次登入實際用的方式（hook 建 session 時依端點寫入 `sessions.login_method`）；讀不到就不帶，需要它的用例會拒絕。
    // 老師要不要先補資料（票 8）：未命中時跟身分一起查好、隨快取存著，`requireRole('teacher')` 不再每次另查（B 設計方案 §4.1）。
    const teacherSetupPending = roles.includes('teacher') ? await teacherNeedsSetup(getPool(), row.id) : undefined
    const method = (session.session as { loginMethod?: unknown } | undefined)?.loginMethod
    const loginMethod = method === 'google' || method === 'password' ? method : undefined

    const actor: Authenticated = {
      kind: 'authenticated',
      userId: row.id,
      roles,
      // 去識別化過的帳號即使 `status` 還沒改，也一律當作已失效（契約 03 §3）。
      status: row.deidentifiedAt ? 'deidentified' : (row.status as AccountStatus),
      mustChangePassword: row.mustChangePassword,
      // 學生的屆別在 profile；老師與管理員沒有屆別成員關係。
      cohortMemberships: row.cohortId
        ? roles.filter((r) => r === 'student').map((role) => ({ cohortId: row.cohortId as string, role }))
        : [],
      displayName: (row.displayName ?? row.name).trim() || undefined,
      avatarPreset: row.avatarPreset,
      avatarFileId: row.avatarFileId,
      ...(teacherSetupPending === undefined ? {} : { teacherSetupPending }),
      ...(loginMethod ? { loginMethod } : {}),
    }
    return { actor, session: { token: session.session.token, expiresAt: new Date(session.session.expiresAt) } }
  }
}
