import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { uuidv7 } from 'uuidv7'
import {
  normalizeName,
  normalizeTeacherProfile,
  teacherSetupDenied,
  type ResolvedActor,
  type TeacherProfileInput,
  type TeacherProfileView,
  type TeacherSetupCommand,
} from '@/application/accounts'
import type { AuditWriter } from '@/application/ops'
import { defaultNextStep, type ErrorCode } from '@/shared/errors'
import { err, ok, type Err, type Result } from '@/shared/result'
import { RealClock, type Clock } from '@/shared/time'

/**
 * 老師第一次登入補資料（產品模組 01 §2.4「老師帳號」；工程模組 01 附錄 A
 * `user_profiles.profile_completed_at`「老師首次補資料」；票 8）。
 *
 * 系辦建的老師帳號（直接新增或預授權）一開始沒有 `user_profiles` 列；老師第一次登入後
 * 補姓名與聯絡資料（不需要學號），寫進 `user_profiles` 並押上 `profile_completed_at`，
 * 之後才進老師首頁。「要不要補」只看資料庫：有老師角色、而且沒有補完的 profile。
 */

export type TeacherSetupDeps = {
  readonly audit: AuditWriter<PoolClient>
  readonly db: () => Pool
  readonly clock?: Clock
}

function denied(code: ErrorCode): Err {
  const messages: Partial<Record<ErrorCode, string>> = {
    UNAUTHENTICATED: '請先登入。',
    FORBIDDEN: '這一頁只給老師補資料。',
    PASSWORD_CHANGE_REQUIRED: '請先修改密碼。',
    ACCOUNT_PENDING: '帳號還在審核中。',
  }
  return err(code, messages[code] ?? '無法執行這個動作。', { next: defaultNextStep(code) })
}

export class PgTeacherSetupCommand implements TeacherSetupCommand {
  readonly #deps: TeacherSetupDeps
  readonly #clock: Clock

  constructor(deps: TeacherSetupDeps) {
    this.#deps = deps
    this.#clock = deps.clock ?? new RealClock()
  }

  async needsSetup(userId: string): Promise<boolean> {
    const rows = await this.#deps.db().query<{ needs: boolean }>(
      `select exists (
                select 1 from role_assignments
                 where user_id = $1 and role = 'teacher' and revoked_real_at is null
              )
          and not exists (
                select 1 from user_profiles where user_id = $1 and profile_completed_at is not null
              ) as needs`,
      [userId],
    )
    return rows.rows[0]?.needs === true
  }

  async view(actor: ResolvedActor): Promise<Result<TeacherProfileView>> {
    const blocked = teacherSetupDenied(actor)
    if (blocked || actor.kind !== 'authenticated') return denied(blocked ?? 'UNAUTHENTICATED')

    const rows = await this.#deps.db().query<{
      email: string
      name: string
      display_name: string | null
      phone: string | null
      contact_email: string | null
      profile_completed_at: Date | null
    }>(
      `select u.email, u.name, up.display_name, up.phone, up.contact_email, up.profile_completed_at
         from users u
         left join user_profiles up on up.user_id = u.id
        where u.id = $1`,
      [actor.userId],
    )
    const row = rows.rows[0]
    if (!row) return denied('UNAUTHENTICATED')
    // 預授權沒填姓名時，`users.name` 暫放的是 Email（見 account-command）；那不是姓名，不預填。
    const suggestedName = row.display_name ?? (row.name === row.email ? '' : row.name)
    return ok(
      {
        loginEmail: row.email,
        displayName: suggestedName,
        phone: row.phone ?? '',
        contactEmail: row.contact_email ?? row.email,
        completed: row.profile_completed_at !== null,
      },
      { requestId: uuidv7(), serverTime: this.#clock.now().toISOString() },
    )
  }

  async complete(actor: ResolvedActor, input: TeacherProfileInput): Promise<Result<{ readonly completedAt: string }>> {
    const blocked = teacherSetupDenied(actor)
    if (blocked || actor.kind !== 'authenticated') return denied(blocked ?? 'UNAUTHENTICATED')
    const normalized = normalizeTeacherProfile(input)
    if (!normalized.ok) return normalized
    const profile = normalized.value

    const now = this.#clock.now()
    const tx = await this.#deps.db().connect()
    try {
      await tx.query('begin')
      // 先鎖人、再看 profile（與註冊、審核同一個順序：users → 其他表）。
      await tx.query('select id from users where id = $1 for no key update', [actor.userId])
      const existing = await tx.query<{ profile_completed_at: Date | null }>(
        'select profile_completed_at from user_profiles where user_id = $1 for update',
        [actor.userId],
      )
      if (existing.rows[0]?.profile_completed_at) {
        await tx.query('rollback')
        // 另一個分頁已經補過了；聯絡資料之後在「我的帳號」改（票 10）。
        return err('CONFLICT', '資料已經補過了，請重新整理。')
      }

      await tx.query(
        `insert into user_profiles
           (user_id, display_name, name_normalized, phone, contact_email, profile_completed_at,
            created_at, updated_at, updated_by_user_id)
         values ($1, $2, $3, $4, $5, $6, $6, $6, $1)
         on conflict (user_id) do update set
           display_name = excluded.display_name,
           name_normalized = excluded.name_normalized,
           phone = excluded.phone,
           contact_email = excluded.contact_email,
           profile_completed_at = excluded.profile_completed_at,
           revision = user_profiles.revision + 1,
           updated_at = excluded.updated_at,
           updated_by_user_id = excluded.updated_by_user_id`,
        [actor.userId, profile.displayName, normalizeName(profile.displayName), profile.phone, profile.contactEmail, now],
      )
      await tx.query('update users set name = $2, updated_at = $3 where id = $1', [actor.userId, profile.displayName, now])
      await this.#deps.audit.append(tx, {
        actorKind: 'user',
        actorUserId: actor.userId,
        role: 'teacher',
        action: 'account.complete_teacher_profile',
        targetType: 'user',
        targetId: actor.userId,
        scope: 'global',
        realAt: now,
        businessAt: now,
        payload: { phoneProvided: profile.phone !== null },
      })
      await tx.query('commit')
      return ok({ completedAt: now.toISOString() }, { requestId: uuidv7(), serverTime: now.toISOString() })
    } catch (error) {
      await tx.query('rollback').catch(() => undefined)
      throw error
    } finally {
      tx.release()
    }
  }
}
