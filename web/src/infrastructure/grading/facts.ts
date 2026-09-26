import 'server-only'
import type { Pool, PoolClient } from 'pg'
import type { CountedEvaluation } from '@/application/grading'
import type { EventPublisher } from '@/application/notifications'
import { canonicalJson } from '@/application/ops'
import { sha256 } from '@/infrastructure/ops/audit-writer'

/**
 * 成績的「事實」與計算基礎的 hash（票 24；模組實作設計 06 §2「預覽綁 basis_hash」、§6）。
 *
 * 成績表、計算明細、改派預覽／執行、更正、套用新版本、匯出都從這裡拿**同一段 SQL** 的事實：
 * - 要求份數（`stage_requirements`）。
 * - 採計中的正式評分：`evaluation_status.state='counted'`，**不看指派是否還有效**——改派選「保留」「新增」後，
 *   舊老師的分數留在已結束的指派上繼續採計。
 * - 有效指派（缺評、改派的鎖與 hash 用）。
 *
 * 兩種 hash：
 * - `stageBasisHash`（改派預覽）：sha256(方案版本 ID ＋ 該組該階段有效指派 ID ＋ 採計評分 ID ＋ 要求份數)。
 *   預覽之後有人送分、退回、改派、套用方案或改份數，執行時重算就對不上 → `CONFLICT`（要重新預覽）。
 * - `groupBasisHash`（更正）：sha256(方案版本 ID ＋ 這組每個階段的要求份數 ＋ 全部採計評分 ID)。
 *   存在 `grade_overrides.basis_hash`；之後算出來不一樣，那筆更正就進「待復核」。只換主指導不在裡面，所以不影響更正。
 */

type Db = Pick<Pool, 'query'> | PoolClient

/** 老師帳號停用、去識別或不再是老師（`u`＝users）。 */
export const TEACHER_INACTIVE_SQL = `not (u.status = 'active' and u.deidentified_at is null
  and exists (select 1 from role_assignments r where r.user_id = u.id and r.role = 'teacher' and r.revoked_real_at is null))`

export const TEACHER_NAME_SQL = `coalesce(nullif(btrim(p.display_name), ''), u.name)`

export type ActiveAssignment = {
  readonly id: string
  readonly groupId: string
  readonly stageKey: string
  readonly teacherUserId: string
  readonly teacherName: string
  readonly teacherInactive: boolean
}

export type GroupFacts = {
  readonly requirements: Map<string, number>
  readonly counted: CountedEvaluation[]
  readonly active: ActiveAssignment[]
}

const empty = (): GroupFacts => ({ requirements: new Map(), counted: [], active: [] })

/** 多組的事實一次查完（成績表、匯出、套用預覽）。沒有資料的組也有一份空的。 */
export async function loadFacts(db: Db, groupIds: readonly string[]): Promise<Map<string, GroupFacts>> {
  const facts = new Map<string, GroupFacts>(groupIds.map((id) => [id, empty()]))
  if (groupIds.length === 0) return facts
  // 一條一條查：交易裡的 `db` 是同一條連線，不能同時丟多個查詢（pg 會排隊並警告）。
  const requirements = await db.query<{ group_id: string; stage_key: string; required_count: number }>(
    'select group_id, stage_key, required_count from stage_requirements where group_id = any($1::uuid[])',
    [groupIds],
  )
  const counted = await db.query<{
    evaluation_id: string
    assignment_id: string
    group_id: string
    stage_key: string
    teacher_user_id: string
    teacher_name: string
    scores: Record<string, string>
    submitted_real_at: Date
    ended: boolean
  }>(
    `select e.id as evaluation_id, e.assignment_id, a.group_id, a.stage_key, a.teacher_user_id,
            ${TEACHER_NAME_SQL} as teacher_name, e.scores, e.submitted_real_at,
            -- 「已改派保留」只算改派三選一結束的指派；組別解散結束的（removal_choice 空）分數照舊，不標改派。
            (a.valid_to is not null and a.removal_choice is not null) as ended
       from evaluation_status s
       join evaluations e on e.id = s.evaluation_id
       join evaluator_assignments a on a.id = s.assignment_id
       join users u on u.id = a.teacher_user_id
       left join user_profiles p on p.user_id = a.teacher_user_id
      where a.group_id = any($1::uuid[]) and s.state = 'counted'
      order by e.submitted_real_at, e.id`,
    [groupIds],
  )
  const active = await db.query<{
    id: string
    group_id: string
    stage_key: string
    teacher_user_id: string
    teacher_name: string
    inactive: boolean
  }>(
    `select a.id, a.group_id, a.stage_key, a.teacher_user_id, ${TEACHER_NAME_SQL} as teacher_name, ${TEACHER_INACTIVE_SQL} as inactive
       from evaluator_assignments a
       join users u on u.id = a.teacher_user_id
       left join user_profiles p on p.user_id = a.teacher_user_id
      where a.group_id = any($1::uuid[]) and a.valid_to is null
      order by a.created_at, a.id`,
    [groupIds],
  )
  for (const r of requirements.rows) facts.get(r.group_id)?.requirements.set(r.stage_key, r.required_count)
  for (const c of counted.rows) {
    facts.get(c.group_id)?.counted.push({
      evaluationId: c.evaluation_id,
      assignmentId: c.assignment_id,
      stageKey: c.stage_key,
      teacherUserId: c.teacher_user_id,
      teacherName: c.teacher_name,
      scores: c.scores,
      submittedAt: c.submitted_real_at,
      assignmentEnded: c.ended,
    })
  }
  for (const a of active.rows) {
    facts.get(a.group_id)?.active.push({
      id: a.id,
      groupId: a.group_id,
      stageKey: a.stage_key,
      teacherUserId: a.teacher_user_id,
      teacherName: a.teacher_name,
      teacherInactive: a.inactive,
    })
  }
  return facts
}

export async function loadGroupFacts(db: Db, groupId: string): Promise<GroupFacts> {
  return (await loadFacts(db, [groupId])).get(groupId) ?? empty()
}

const sorted = (values: Iterable<string>) => [...values].sort()

/** 改派預覽／執行的 hash（見檔頭）。 */
export function stageBasisHash(versionId: string | null, stageKey: string, facts: GroupFacts): string {
  return sha256(
    canonicalJson({
      kind: 'stage',
      versionId,
      stageKey,
      required: facts.requirements.get(stageKey) ?? null,
      active: sorted(facts.active.filter((a) => a.stageKey === stageKey).map((a) => a.id)),
      counted: sorted(facts.counted.filter((c) => c.stageKey === stageKey).map((c) => c.evaluationId)),
    }),
  )
}

/** 更正的計算基礎（見檔頭）。 */
export function groupBasisHash(versionId: string | null, facts: GroupFacts): string {
  return sha256(
    canonicalJson({
      kind: 'group',
      versionId,
      requirements: sorted([...facts.requirements.entries()].map(([k, n]) => `${k}:${n}`)),
      counted: sorted(facts.counted.map((c) => c.evaluationId)),
    }),
  )
}

/** 這一組所屬屆別目前套用的方案版本 ID（沒有是 null）。 */
export async function currentVersionIdOfGroup(db: Db, groupId: string): Promise<string | null> {
  const row = await db.query<{ version_id: string | null }>(
    `select s.current_version_id as version_id from groups g join grading_schemes s on s.cohort_id = g.cohort_id where g.id = $1`,
    [groupId],
  )
  return row.rows[0]?.version_id ?? null
}

/** 有處理權的管理員（待復核通知的收件人）。 */
export async function activeAdminIds(db: Db): Promise<string[]> {
  const rows = await db.query<{ user_id: string }>(
    `select distinct ra.user_id from role_assignments ra join users u on u.id = ra.user_id
      where ra.role = 'admin' and ra.revoked_real_at is null and u.status = 'active' and u.deidentified_at is null
      order by ra.user_id`,
  )
  return rows.rows.map((r) => r.user_id)
}

/**
 * 計算基礎改變後，把這一組「生效中」的更正標成「待復核」（產品 7.5；模組實作設計 06 §6「基礎變更用例同交易」）。
 *
 * 呼叫者：正式送出、退回、改派（三選一）、改要求份數、套用新方案版本——都在各自的交易裡、上完鎖之後呼叫。
 * 只有「生效中 → 待復核」這一次發通知給管理員（首次進入待復核；未解決不反覆提醒）。回傳這次標了幾筆。
 */
export async function flagOverridesForReview(
  tx: PoolClient,
  events: EventPublisher<PoolClient>,
  input: {
    readonly groupId: string
    readonly cohortId: string
    readonly actor: { readonly kind: 'user'; readonly userId: string }
    readonly realAt: Date
    readonly businessAt: Date
  },
): Promise<number> {
  const effective = await tx.query<{ id: string; basis_hash: string; scheme_version_id: string; code: string }>(
    `select o.id, o.basis_hash, o.scheme_version_id, g.code
       from grade_overrides o
       join override_review_state r on r.override_id = o.id
       join groups g on g.id = o.group_id
      where o.group_id = $1 and r.state = 'effective'
      for update of r`,
    [input.groupId],
  )
  if (effective.rowCount === 0) return 0
  const versionId = await currentVersionIdOfGroup(tx, input.groupId)
  const basis = groupBasisHash(versionId, await loadGroupFacts(tx, input.groupId))
  const stale = effective.rows.filter((o) => o.basis_hash !== basis || o.scheme_version_id !== versionId)
  if (stale.length === 0) return 0
  await tx.query(
    `update override_review_state set state = 'pending_review', revision = revision + 1, updated_at = $2
      where override_id = any($1::uuid[]) and state = 'effective'`,
    [stale.map((o) => o.id), input.realAt],
  )
  const admins = await activeAdminIds(tx)
  for (const o of stale) {
    if (admins.length === 0) continue
    await events.publish(tx, {
      type: 'grading.override_review',
      scope: 'cohort',
      cohortId: input.cohortId,
      source: { type: 'grade_override', id: o.id, version: 1 },
      actor: input.actor,
      recipients: admins,
      recipientBasis: { basis: 'admin_role', overrideId: o.id },
      // 只有組別代號：通知匣不放分數（管理員點進去看）。
      payload: { title: `${o.code} 的成績更正待復核：計算基礎改變了`, groupId: input.groupId, code: o.code },
      occurredRealAt: input.realAt,
      occurredBusinessAt: input.businessAt,
    })
  }
  return stale.length
}
