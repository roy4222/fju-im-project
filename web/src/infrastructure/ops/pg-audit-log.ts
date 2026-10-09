import 'server-only'
import type { Pool } from 'pg'
import {
  AUDIT_EXCLUDED_ACTIONS,
  AUDIT_PAGE_LIMIT,
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

export async function readAuditLog(db: Pick<Pool, 'query'>, who: AuditWhoFilter, now: Date = new Date()): Promise<AuditLog> {
  const since = new Date(now.getTime() - AUDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const base = `from audit_events a
    where a.real_at >= $1 and not (a.action = any($2::text[]))`

  const countResult = await db.query<Record<AuditWhoFilter | 'with_reason', string>>(
    `select ${AUDIT_WHO_FILTERS.map((w) => `count(*) filter (where ${WHO_SQL[w]}) as "${w}"`).join(', ')},
            count(*) filter (where nullif(btrim(a.reason), '') is not null) as with_reason
       ${base}`,
    [since, AUDIT_EXCLUDED_ACTIONS],
  )
  const raw = countResult.rows[0]
  const counts = Object.fromEntries(AUDIT_WHO_FILTERS.map((w) => [w, Number(raw?.[w] ?? 0)])) as Record<AuditWhoFilter, number>

  const rows = await db.query<Row>(
    `select a.id, a.real_at, a.actor_kind, a.role, a.action, a.target_type, a.reason, a.verification_method,
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
            c.code as cohort_code, c.name as cohort_name
       from audit_events a
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
      where a.real_at >= $1 and not (a.action = any($2::text[])) and ${WHO_SQL[who]}
      order by a.real_at desc, a.id desc
      limit $3`,
    [since, AUDIT_EXCLUDED_ACTIONS, AUDIT_PAGE_LIMIT],
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
  return { who, since, entries, counts, withReason: Number(raw?.with_reason ?? 0), truncated: counts[who] > entries.length }
}
