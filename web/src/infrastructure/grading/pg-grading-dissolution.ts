import 'server-only'
import { uuidv7 } from 'uuidv7'
import type { PoolClient } from 'pg'
import type { GradingDissolutionHook } from '@/application/grading'

/**
 * 組別解散時停止評分工作（開站後；`GradingDissolutionHook`）。在解散用例的交易裡跑，組別列已經 `FOR UPDATE`。
 *
 * - 有效評分指派全部結束：`valid_to`＝解散的業務時間（不早於起始）、`ended_real_at`＝解散的真實時間、
 *   `removal_choice` 留空——改派三選一一定有值，所以「結束但沒有選擇」就是因解散結束（成績表不標「已改派保留」）。
 * - 暫存一律失效（`draft` → `invalidated`，留狀態事件）；已正式送出的分數不動（凍結、照舊採計）。
 * - 方案版本只讀不鎖：記進解散的稽核 payload，給解散後的成績表釘版本用；鎖方案會跟套用新版本（先方案後組別）反向。
 */
export class PgGradingDissolution implements GradingDissolutionHook<PoolClient> {
  async endForDissolvedGroup(
    tx: PoolClient,
    input: { groupId: string; cohortId: string; actorUserId: string; reason: string; realAt: Date; businessAt: Date },
  ) {
    const scheme = await tx.query<{ id: string; version_no: number; status: string }>(
      `select v.id, v.version_no, v.status
         from grading_schemes s join grading_scheme_versions v on v.id = s.current_version_id
        where s.cohort_id = $1`,
      [input.cohortId],
    )
    const schemeRow = scheme.rows[0]
    const actives = await tx.query<{ id: string; teacher_user_id: string }>(
      `select id, teacher_user_id from evaluator_assignments where group_id = $1 and valid_to is null order by id for update`,
      [input.groupId],
    )
    const ids = actives.rows.map((a) => a.id)
    const why = `組別解散：${input.reason}`
    let drafts: string[] = []
    if (ids.length > 0) {
      await tx.query(
        `update evaluator_assignments
            set valid_to = greatest(valid_from, $2), ended_real_at = $3, ended_by_user_id = $4, removal_choice = null, reason = $5,
                revision = revision + 1, updated_at = $3
          where id = any($1::uuid[])`,
        [ids, input.businessAt, input.realAt, input.actorUserId, why],
      )
      const found = await tx.query<{ evaluation_id: string }>(
        `select evaluation_id from evaluation_status where assignment_id = any($1::uuid[]) and state = 'draft' order by evaluation_id for update`,
        [ids],
      )
      drafts = found.rows.map((d) => d.evaluation_id)
      for (const evaluationId of drafts) {
        await tx.query(
          `update evaluation_status set state = 'invalidated', revision = revision + 1, updated_at = $2, updated_by_user_id = $3
            where evaluation_id = $1`,
          [evaluationId, input.realAt, input.actorUserId],
        )
        await tx.query(
          `insert into evaluation_status_events (id, evaluation_id, from_state, to_state, reason, actor_kind, actor_user_id, real_at)
           values ($1, $2, 'draft', 'invalidated', $3, 'user', $4, $5)`,
          [uuidv7(), evaluationId, why, input.actorUserId, input.realAt],
        )
      }
    }
    return {
      endedAssignmentIds: ids,
      invalidatedDraftIds: drafts,
      teacherUserIds: [...new Set(actives.rows.map((a) => a.teacher_user_id))],
      schemeVersion: schemeRow ? { id: schemeRow.id, versionNo: schemeRow.version_no, status: schemeRow.status } : null,
    }
  }
}
