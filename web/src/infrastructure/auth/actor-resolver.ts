import 'server-only'
import { getSessionCookie } from 'better-auth/cookies'
import { and, eq, isNull } from 'drizzle-orm'
import {
  ANONYMOUS,
  type AccountStatus,
  type ActorResolver,
  type ResolvedActor,
  type Role,
} from '@/application/accounts'
import { getDb } from '@/infrastructure/db/client'
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
    // 鍵是 cookie 裡已簽章的 session token（`getSessionCookie` 是套件自己的讀法）。沒有 cookie 就是匿名，不查也不存。
    const token = cache.enabled ? getSessionCookie(headers) : null
    if (token) {
      const hit = cache.get(token, this.#now())
      if (hit) return hit
    }

    const ticket = cache.beginLoad()
    const loaded = await this.#load(headers)
    // 只在「套件驗過的就是這張 cookie」時存：同時帶 `__Secure-` 與一般兩種名字時，
    // 我們拿來當鍵的那張不一定是套件驗的那張（簽章格式是 `<token>.<signature>`）。
    if (token && loaded.session && token.startsWith(`${loaded.session.token}.`)) {
      cache.set(token, loaded.actor, { now: this.#now(), sessionExpiresAt: loaded.session.expiresAt, ticket })
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
        // 老師要不要先補資料（票 8）也在同一句讀，`requireRole('teacher')` 不再每次另查（B 設計方案 §4.1）。
        profileCompletedAt: userProfiles.profileCompletedAt,
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
      // 跟 `PgTeacherSetupCommand.needsSetup` 同一個條件：有老師角色、而且 profile 還沒補完。
      ...(roles.includes('teacher') ? { teacherSetupPending: row.profileCompletedAt === null } : {}),
      ...(loginMethod ? { loginMethod } : {}),
    }
    return { actor, session: { token: session.session.token, expiresAt: new Date(session.session.expiresAt) } }
  }
}
