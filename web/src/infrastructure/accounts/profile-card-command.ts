import 'server-only'
import type { Pool, PoolClient } from 'pg'
import {
  normalizeProfileCard,
  statusGate,
  type ProfileCard,
  type ProfileCardCommand,
  type ProfileCardInput,
  type ProfileCardQuery,
  type ResolvedActor,
} from '@/application/accounts'
import type { BusinessClockSource } from '@/application/cohorts'
import { canonicalJson, type AuditWriter, type OperationLedger } from '@/application/ops'
import { err, ok, type Result } from '@/shared/result'
import { RealClock, type Clock } from '@/shared/time'
import { badRequestId, inTransaction, replayed } from '@/infrastructure/cohorts/shared'
import { personAvatar } from '@/infrastructure/db/person-avatar'
import { personName } from '@/infrastructure/db/person-name'
import { sha256 } from '@/infrastructure/ops/audit-writer'

/**
 * 學生名片卡（C3 設計方案 §4.3、§4.5；票 C3-07）：讀自己的名片、一次存自介／技能／聯絡 Email／公開找隊員。
 *
 * 一個交易：帳本 `begin` → 屆別 FOR SHARE（封存後開關不能動，同 `setOpenToJoin`）→ 鎖自己的 `user_profiles`
 * → 比對 `revision` → 已有組別時不准打開公開（`ALREADY_MEMBER`，既有保證）→ 寫入 → 稽核只記改了哪幾欄 → 帳本 `commit`。
 * 只改 actor 自己那一列：介面沒有「替誰改」的參數，老師、系辦呼叫一律 `FORBIDDEN`。
 */

export type ProfileCardDeps = {
  readonly audit: AuditWriter<PoolClient>
  readonly ledger: OperationLedger<PoolClient>
  readonly db: () => Pool
  readonly businessClock: BusinessClockSource
  readonly clock?: Clock
}

const OPERATION = 'account.profile_card_update'

const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

/** 學生本人：狀態閘門過了、有學生角色、有屆別。 */
function authorizeOwner(actor: ResolvedActor): { ok: true; userId: string; cohortId: string } | ReturnType<typeof err> {
  const blocked = statusGate(actor, 'business')
  if (blocked) return err(blocked, '請先登入並完成帳號設定。')
  if (actor.kind !== 'authenticated' || !actor.roles.includes('student')) return err('FORBIDDEN', '只有學生本人可以編輯名片。')
  const cohortId = actor.cohortMemberships.find((m) => m.role === 'student')?.cohortId
  if (!cohortId) return err('VALIDATION_FAILED', '你的帳號還沒有屆別，請聯絡系辦。', { next: { kind: 'contact_office' } })
  return { ok: true, userId: actor.userId, cohortId }
}

type CardRow = {
  user_id: string
  name: string
  avatar_preset: number | null
  avatar_file_id: string | null
  student_no: string | null
  department_class: string | null
  bio: string
  skills: string[]
  contact_email: string
  open_to_join: boolean
  revision: number
  grouped: boolean
}

export class PgProfileCardCommand implements ProfileCardCommand, ProfileCardQuery {
  readonly #deps: ProfileCardDeps
  readonly #clock: Clock

  constructor(deps: ProfileCardDeps) {
    this.#deps = deps
    this.#clock = deps.clock ?? new RealClock()
  }

  async mine(actor: ResolvedActor): Promise<ProfileCard | null> {
    if (actor.kind !== 'authenticated' || !actor.roles.includes('student')) return null
    // 一句讀完：名片欄位、頭像、是否已有組別（「公開找隊員」開關要不要 disabled）。
    const rows = await this.#deps.db().query<CardRow>(
      `select p.user_id, ${personName('p', 'u')} as name, ${personAvatar('p')}, p.student_no, p.department_class,
              p.bio, p.skills, p.contact_email, p.open_to_join, p.revision,
              exists (select 1 from group_memberships m
                       where m.user_id = p.user_id and m.cohort_id = p.cohort_id and m.valid_to is null) as grouped
         from user_profiles p
         join users u on u.id = p.user_id
        where p.user_id = $1`,
      [actor.userId],
    )
    const row = rows.rows[0]
    if (!row) return null
    return {
      id: row.user_id,
      name: row.name,
      avatarPreset: row.avatar_preset,
      avatarFileId: row.avatar_file_id,
      studentNo: row.student_no,
      departmentClass: row.department_class || null,
      bio: row.bio,
      skills: Array.isArray(row.skills) ? row.skills.filter((s): s is string => typeof s === 'string') : [],
      contactEmail: row.contact_email,
      openToJoin: row.open_to_join && !row.grouped,
      canOpenToJoin: !row.grouped,
      revision: row.revision,
    }
  }

  async save(
    actor: ResolvedActor,
    input: ProfileCardInput & { readonly revision: number },
    requestId: string,
  ): Promise<Result<{ revision: number }>> {
    const who = authorizeOwner(actor)
    if (!who.ok) return who
    if (!isUuid(requestId)) return badRequestId()
    if (!Number.isInteger(input.revision) || input.revision < 1) {
      return err('VALIDATION_FAILED', '頁面資料不完整，請重新整理後再試。')
    }
    const normalized = normalizeProfileCard(input)
    if (!normalized.ok) return normalized
    const card = normalized.value
    const { userId, cohortId } = who
    const businessAt = await this.#deps.businessClock.now()

    return inTransaction(this.#deps.db, 'profile-card', async (tx) => {
      const realAt = this.#clock.now()
      const begun = await this.#deps.ledger.begin(
        tx,
        {
          actorUserId: userId,
          operationKind: OPERATION,
          requestId,
          fingerprint: sha256(canonicalJson({ ...card, revision: input.revision })),
          scope: 'cohort',
          cohortId,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<{ revision: number }>(begun)

      const cohort = await tx.query<{ status: string }>('select status from cohorts where id = $1 for share', [cohortId])
      if (!cohort.rows[0]) return err('VALIDATION_FAILED', '找不到你的屆別，請聯絡系辦。')

      const before = await tx.query<{ bio: string; skills: string[]; contact_email: string; open_to_join: boolean; revision: number }>(
        'select bio, skills, contact_email, open_to_join, revision from user_profiles where user_id = $1 for update',
        [userId],
      )
      const current = before.rows[0]
      if (!current) return err('FORBIDDEN', '你的基本資料還沒建立，請聯絡系辦。')
      if (current.revision !== input.revision) return err('CONFLICT', '名片在別的地方改過了，請重新整理後再改一次。')

      const changed = [
        ...(current.bio !== card.bio ? ['bio'] : []),
        ...(JSON.stringify(current.skills) !== JSON.stringify(card.skills) ? ['skills'] : []),
        ...(current.contact_email !== card.contactEmail ? ['contactEmail'] : []),
        ...(current.open_to_join !== card.openToJoin ? ['openToJoin'] : []),
      ]
      if (changed.includes('openToJoin') && cohort.rows[0].status === 'archived') {
        return err('COHORT_ARCHIVED', '這一屆已封存，分組資料只能查看。')
      }
      if (card.openToJoin) {
        const member = await tx.query(
          'select 1 from group_memberships where user_id = $1 and cohort_id = $2 and valid_to is null limit 1',
          [userId, cohortId],
        )
        if (member.rows.length > 0) return err('ALREADY_MEMBER', '你已經有組別了，不需要公開找隊員。')
      }

      let revision = current.revision
      if (changed.length > 0) {
        const updated = await tx.query<{ revision: number }>(
          `update user_profiles
              set bio = $2, skills = $3::jsonb, contact_email = $4, open_to_join = $5,
                  revision = revision + 1, updated_at = $6, updated_by_user_id = $1
            where user_id = $1
          returning revision`,
          [userId, card.bio, JSON.stringify(card.skills), card.contactEmail, card.openToJoin, realAt],
        )
        revision = updated.rows[0]!.revision
        // 稽核只記「改了哪幾欄」與版本，不記自介、Email 本身（個資最小化，同 `account.update_contact`）。
        await this.#deps.audit.append(tx, {
          actorKind: 'user',
          actorUserId: userId,
          role: 'student',
          action: OPERATION,
          targetType: 'user',
          targetId: userId,
          scope: 'cohort',
          cohortId,
          realAt,
          businessAt,
          payload: { changed, revision, openToJoin: card.openToJoin },
        })
      }
      const result = ok({ revision }, { requestId, serverTime: realAt.toISOString() })
      await this.#deps.ledger.commit(tx, begun.recordId, { receipt: result.receipt, resultRef: { userId } })
      return result
    })
  }
}
