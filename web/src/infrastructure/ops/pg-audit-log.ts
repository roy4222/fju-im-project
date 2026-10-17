import 'server-only'
import type { Pool } from 'pg'
import {
  AUDIT_EXCLUDED_ACTIONS,
  AUDIT_PAGE_LIMIT,
  AUDIT_TARGET_TYPE_LABEL_ENTRIES,
  AUDIT_WHO_FILTERS,
  AUDIT_WINDOW_DAYS,
  type AuditLog,
  type AuditLogEntry,
  type AuditWhoFilter,
} from '@/application/ops'
import { personName } from '@/infrastructure/db/person-name'

/**
 * 「操作紀錄」頁的查詢（票 36）：最近 `AUDIT_WINDOW_DAYS` 天的 `audit_events`，新到舊，依角色分頁。
 *
 * 只選畫面要的欄位；**不選 `payload`**（追溯用的內部欄位，畫面不顯示）。唯一例外：核准註冊（`account.approve`）
 * 只取 `payload->>'verificationNote'` 這一個鍵（核實說明沒有獨立欄位；見 `application/ops/audit-log.ts` 檔頭）。
 * 對象名稱解五種（帳號與註冊申請＝姓名、組別＝組別代碼、屆別＝「名稱（代碼）」、活動＝標題），其他類型只顯示類型。
 * 姓名一律用 join 即時查（`personName`），不寫回稽核紀錄；去識別化後這裡跟著變成去識別化後的名字。
 * 授權不在這裡判：由 composition 的 `getAuditLogQuery()` 先確認是有效管理員才呼叫。
 */

/** 分頁條件（SQL 片段）。`a` 是 audit_events 的別名。 */
const WHO_SQL: Record<AuditWhoFilter, string> = {
  all: 'true',
  admin: "a.actor_kind = 'user' and a.role = 'admin'",
  teacher: "a.actor_kind = 'user' and a.role = 'teacher'",
  student: "a.actor_kind = 'user' and a.role = 'student'",
  // 沒有角色的本人動作（送出註冊申請時還沒有角色）。少了這一欄，各分頁加起來會小於「全部」（系3）。
  other: "a.actor_kind = 'user' and (a.role is null or a.role not in ('admin','teacher','student'))",
  system: "a.actor_kind <> 'user'",
}

type Row = {
  id: string
  real_at: Date
  actor_kind: AuditLogEntry['actorKind']
  actor_name: string | null
  role: AuditLogEntry['role']
  action: string
  target_type: string
  target_name: string | null
  cohort_code: string | null
  cohort_name: string | null
  reason: string | null
  verification_method: AuditLogEntry['verificationMethod']
  verification_note: string | null
}

/** LIKE 的萬用字元（`%` `_`）與跳脫字元本身要跳脫，使用者輸入才會被當成一般字。 */
const likeEscape = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`)

/**
 * `q`（A-11／AD-B6）：已 trim 的搜尋字或 null。對「誰」（操作者姓名、帳號 email、聯絡 email）與「對象」（對象名稱）做 `ILIKE '%q%'`；
 * 分頁籤數字與清單用同一份過濾後的資料，所以數字隨搜尋變。長度上限在 application 層（`parseAuditQuery`）判。
 */
export async function readAuditLog(
  db: Pick<Pool, 'query'>,
  who: AuditWhoFilter,
  q: string | null = null,
  now: Date = new Date(),
): Promise<AuditLog> {
  const since = new Date(now.getTime() - AUDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const pattern = q === null ? null : `%${likeEscape(q)}%`

  // 先把窗內、已搜尋過濾的列連同顯示欄位算出來（`ev`），計數與清單都從它取。
  const ev = `with ev as (
    select a.id, a.real_at, a.actor_kind, a.role, a.action, a.target_type, a.reason, a.verification_method,
           case when a.action = 'account.approve' then nullif(btrim(a.payload->>'verificationNote'), '') end as verification_note,
           case when a.actor_user_id is null then null else ${personName('ap', 'au')} end as actor_name,
           case a.target_type
             when 'user' then ${personName('tp', 'tu')}
             when 'registration_application' then ${personName('rp', 'ru')}
             when 'group' then tg.code
             when 'cohort' then tc.name || '（' || tc.code || '）'
             when 'project_event' then te.title
             else null
           end as target_name,
           c.code as cohort_code, c.name as cohort_name,
           au.email as actor_email, ap.contact_email as actor_contact_email,
           tl.label as target_type_label
      from audit_events a
      left join unnest($4::text[], $5::text[]) as tl(type, label) on tl.type = a.target_type
      left join users au on au.id = a.actor_user_id
      left join user_profiles ap on ap.user_id = a.actor_user_id
      left join users tu on a.target_type = 'user' and tu.id = a.target_id
      left join user_profiles tp on a.target_type = 'user' and tp.user_id = a.target_id
      left join registration_applications ra on a.target_type = 'registration_application' and ra.id = a.target_id
      left join users ru on ru.id = ra.user_id
      left join user_profiles rp on rp.user_id = ra.user_id
      left join project_events te on a.target_type = 'project_event' and te.id = a.target_id
      left join groups tg on a.target_type = 'group' and tg.id = a.target_id
      left join cohorts tc on a.target_type = 'cohort' and tc.id = a.target_id
      left join cohorts c on c.id = a.cohort_id
     where a.real_at >= $1 and not (a.action = any($2::text[]))
  ), hit as (
    select * from ev a
     where $3::text is null
        -- 「誰」：畫面上的操作者文字（含「系統」「背景工作」）、帳號 email、聯絡 email。
        or (case a.actor_kind when 'worker' then '背景工作' when 'system' then '系統'
                 else coalesce(nullif(btrim(a.actor_name), ''), '（已不存在的帳號）') end) ilike $3 escape '\\'
        or a.actor_email ilike $3 escape '\\' or a.actor_contact_email ilike $3 escape '\\'
        -- 「對象」：和 describeAuditTarget 同一串字（類型・名字（屆別）），搜得到畫面上看到的任何一段。
        or (coalesce(a.target_type_label, a.target_type)
            || case when nullif(btrim(a.target_name), '') is not null then '・' || btrim(a.target_name) else '' end
            || case when a.target_type <> 'cohort' and coalesce(nullif(btrim(a.cohort_name), ''), a.cohort_code) is not null
                    then '（' || coalesce(nullif(btrim(a.cohort_name), ''), a.cohort_code) || '）' else '' end) ilike $3 escape '\\'
  )`
  const labelTypes = AUDIT_TARGET_TYPE_LABEL_ENTRIES.map(([type]) => type)
  const labelTexts = AUDIT_TARGET_TYPE_LABEL_ENTRIES.map(([, label]) => label)

  const countResult = await db.query<Record<AuditWhoFilter | 'with_reason', string>>(
    `${ev}
     select ${AUDIT_WHO_FILTERS.map((w) => `count(*) filter (where ${WHO_SQL[w]}) as "${w}"`).join(', ')},
            count(*) filter (where nullif(btrim(a.reason), '') is not null) as with_reason
       from hit a`,
    [since, AUDIT_EXCLUDED_ACTIONS, pattern, labelTypes, labelTexts],
  )
  const raw = countResult.rows[0]
  const counts = Object.fromEntries(AUDIT_WHO_FILTERS.map((w) => [w, Number(raw?.[w] ?? 0)])) as Record<AuditWhoFilter, number>

  const rows = await db.query<Row>(
    `${ev}
     select a.id, a.real_at, a.actor_kind, a.role, a.action, a.target_type, a.reason, a.verification_method,
            a.verification_note, a.actor_name, a.target_name, a.cohort_code, a.cohort_name
       from hit a
      where ${WHO_SQL[who]}
      order by a.real_at desc, a.id desc
      limit $6`,
    [since, AUDIT_EXCLUDED_ACTIONS, pattern, labelTypes, labelTexts, AUDIT_PAGE_LIMIT],
  )

  const entries: AuditLogEntry[] = rows.rows.map((r) => ({
    id: r.id,
    realAt: r.real_at,
    actorKind: r.actor_kind,
    actorName: r.actor_name,
    role: r.role,
    action: r.action,
    targetType: r.target_type,
    targetName: r.target_name,
    cohortCode: r.cohort_code,
    cohortName: r.cohort_name,
    reason: r.reason,
    verificationMethod: r.verification_method,
    verificationNote: r.verification_note,
  }))
  return { who, q, since, entries, counts, withReason: Number(raw?.with_reason ?? 0), truncated: counts[who] > entries.length }
}
