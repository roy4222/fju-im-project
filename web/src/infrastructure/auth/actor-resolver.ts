import 'server-only'
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
import { getSessionFromHeaders } from '@/infrastructure/auth/wrapper'

/**
 * 把「這次請求的 cookie」變成「現在是誰」（模組 01 §5）。
 *
 * 關鍵取捨：**狀態一律回資料庫讀**，不信 session cookie 裡帶的內容。
 * Better Auth 的 session 物件上雖然有 `user.status`，但那是登入當下的快照；
 * 系辦在那之後把人停用的話，快照還是舊的。`cookieCache` 已經關掉（S01-02），
 * 這裡再重讀一次 `users`，停用才會立刻生效（契約 03 §3）。
 *
 * 角色來自 `role_assignments` 目前有效的列（`revoked_real_at IS NULL`），
 * 不是 Better Auth admin plugin 的 `users.role`——那是套件自己的欄位，不是業務角色。
 */
export class DbActorResolver implements ActorResolver {
  async resolve(headers: Headers): Promise<ResolvedActor> {
    // `/get-session` 本身已經受帳號狀態矩陣管（S01-02 的 hook）：停用或去識別化的人
    // 會被擋成 UNAUTHENTICATED。那對這裡來說就是「沒有有效登入」，不是錯誤，
    // 所以吞掉例外回 ANONYMOUS——契約 03 §2 的「disabled 一律當作未登入」。
    let session: Awaited<ReturnType<typeof getSessionFromHeaders>> = null
    try {
      session = await getSessionFromHeaders(headers)
    } catch {
      return ANONYMOUS
    }
    if (!session?.user?.id) return ANONYMOUS

    const db = getDb()
    const [row] = await db
      .select({
        id: users.id,
        status: users.status,
        mustChangePassword: users.mustChangePassword,
        deidentifiedAt: users.deidentifiedAt,
        cohortId: userProfiles.cohortId,
      })
      .from(users)
      .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
      .where(eq(users.id, session.user.id))
      .limit(1)

    // session 還在但人已經不在（去識別化把列留著，但這裡讀不到就當未登入）。
    if (!row) return ANONYMOUS

    const assignments = await db
      .select({ role: roleAssignments.role })
      .from(roleAssignments)
      .where(and(eq(roleAssignments.userId, row.id), isNull(roleAssignments.revokedRealAt)))

    const roles = assignments.map((a) => a.role as Role)

    return {
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
    }
  }
}
