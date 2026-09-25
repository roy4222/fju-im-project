import 'server-only'
import type { Pool } from 'pg'
import type { ResolvedActor } from '@/application/accounts'
import type { AdvisorVisibility, SubmissionHolder, SubmissionViewer } from '@/application/submissions'

/**
 * 「誰能讀這一個正式版本」的**事實**，每次當下重查（票 21 下載政策起頭，票 22 抽出來共用）。
 *
 * 附件下載（`submission-file-policy`）、老師的繳交矩陣與版本列表（`pg-advisor-submissions`）、
 * 被移出者的繳交紀錄（`pg-submissions` 的 `myRecords`）都用**同一段 SQL** 拿事實、再經 application 的
 * `canReadSubmission` 判斷——畫面列得出來的版本，就是點得開、附件下載得到的那幾版，不會各算各的。
 *
 * 用到的別名：`v`＝`submission_versions`、`m`＝`managed_items`、`sv`＝那一版的 `form_schema_versions`。
 *
 * - 目前主指導：組別看該組 `advisor_assignments.valid_to IS NULL`；個人看本人**此刻**在這一屆的有效組別的主指導
 *   （組別要沒解散、屆別要跟項目同一屆——契約 03 §1「cohort_id 必比對」，跨屆的新老師看不到以前的回答）。
 * - 閱覽設定：這份收件最新的一列（只插不改）。
 * - 送出當下的組員：`membership_snapshot`。
 * - 此刻的評分老師（票 24、S10-03）：組別收件才有，該組 `evaluator_assignments.valid_to IS NULL` 的老師（屆別要跟項目同一屆）。
 */
export const VERSION_ACCESS_COLUMNS = `
  v.receiver_kind, v.receiver_id, sv.version_no as schema_version_no, v.membership_snapshot,
  case when v.receiver_kind = 'group'
    then (select a.teacher_user_id from advisor_assignments a
            join groups ag on ag.id = a.group_id and ag.cohort_id = m.cohort_id
           where a.group_id = v.receiver_id and a.valid_to is null)
    else (select a.teacher_user_id from group_memberships gm
            join groups g on g.id = gm.group_id and g.status = 'active'
            join advisor_assignments a on a.group_id = gm.group_id and a.valid_to is null
           where gm.user_id = v.receiver_id and gm.cohort_id = m.cohort_id and gm.valid_to is null)
  end as current_advisor,
  (select row_to_json(x) from (
     select s.enabled, s.effective_from_version_no as "effectiveFromVersionNo" from advisor_visibility_settings s
      where s.item_id = v.item_id order by s.set_at desc, s.id desc limit 1) x) as visibility,
  case when v.receiver_kind = 'group'
    then coalesce((select array_agg(distinct ea.teacher_user_id::text) from evaluator_assignments ea
                     join groups eg on eg.id = ea.group_id and eg.cohort_id = m.cohort_id
                    where ea.group_id = v.receiver_id and ea.valid_to is null), '{}'::text[])
    else '{}'::text[]
  end as evaluators`

export type VersionAccessRow = {
  receiver_kind: 'user' | 'group'
  receiver_id: string
  schema_version_no: number
  membership_snapshot: string[] | null
  current_advisor: string | null
  visibility: AdvisorVisibility | null
  evaluators: string[] | null
}

export function holderOf(row: VersionAccessRow): SubmissionHolder {
  return {
    kind: 'version',
    receiverKind: row.receiver_kind,
    receiverId: row.receiver_id,
    schemaVersionNo: row.schema_version_no,
    currentAdvisorUserId: row.current_advisor,
    visibility: row.visibility,
    membershipSnapshot: row.membership_snapshot,
    activeEvaluatorUserIds: row.evaluators ?? [],
  }
}

/** 看的人此刻的身分：管理員、老師、此刻有效（組別未解散）的組別。沒登入回 null。 */
export async function viewerOf(db: Pick<Pool, 'query'>, actor: ResolvedActor): Promise<SubmissionViewer | null> {
  if (actor.kind !== 'authenticated') return null
  return viewerForUser(db, actor.userId, { isAdmin: actor.roles.includes('admin'), isTeacher: actor.roles.includes('teacher') })
}

/** 同上，給已經由頁面守好角色、只拿得到使用者 ID 的查詢（學生作業區）。 */
export async function viewerForUser(
  db: Pick<Pool, 'query'>,
  userId: string,
  roles: { isAdmin: boolean; isTeacher: boolean },
): Promise<SubmissionViewer> {
  const memberships = await db.query<{ group_id: string }>(
    `select gm.group_id from group_memberships gm join groups g on g.id = gm.group_id
      where gm.user_id = $1 and gm.valid_to is null and g.status = 'active'`,
    [userId],
  )
  return { userId, ...roles, memberOfGroupIds: memberships.rows.map((m) => m.group_id) }
}
