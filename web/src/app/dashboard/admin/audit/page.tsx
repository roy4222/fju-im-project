import Link from 'next/link'
import { IconHistory } from '@tabler/icons-react'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { PageTitle, Panel, PanelEmpty, Pill } from '@/app/_ui/dashboard/primitives'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { AdminTabs } from '@/app/dashboard/admin/_tabs'
import { AuditSearch, type AuditSearchRow } from '@/app/dashboard/admin/audit/audit-search'
import type { AuditLogEntry, AuditWhoFilter } from '@/application/ops'
import {
  AUDIT_PAGE_LIMIT,
  AUDIT_QUERY_MAX_LENGTH,
  AuditQueryInvalidError,
  AUDIT_WHO_FILTERS,
  AUDIT_WHO_LABEL,
  AUDIT_WINDOW_DAYS,
  auditActionLabel,
  auditActionTitle,
  auditWhoOf,
  describeAuditTarget,
  getAuditLogQuery,
} from '@/composition/ops'
import { VERIFICATION_LABEL } from '@/composition/accounts'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute } from '@/shared/time'

export const metadata = { title: '操作紀錄｜資管系專題平台' }

const BASE = '/dashboard/admin/audit'

/** 設定的四個分頁（設計方案 §3.6；D-1 `h1` 用側欄名「設定」）。 */
const SETTINGS_TABS = [
  { href: '/dashboard/admin/cohorts', label: '屆別' },
  { href: '/dashboard/admin/timeline', label: '時間軸' },
  { href: '/dashboard/admin/home-settings', label: '首頁設定' },
  { href: '/dashboard/admin/audit', label: '操作紀錄' },
] as const

/**
 * 管理員「操作紀錄」（票 36；原型 `/dashboard/admin/audit`；模組 10「依角色篩選，每筆有時間、人、動作、對象、理由；不可修改」）。
 *
 * 資料是既有的稽核紀錄（`audit_events`），這一頁只讀、沒有任何修改入口。一頁一個焦點＝清單，各角色筆數放在篩選膠囊上。
 * 角色篩選用網址（`?role=`）：重新整理不會丟，也不用在瀏覽器裝整份資料。
 * AD-15：掛「設定」分頁列、角色分頁改成膠囊、拿掉頁首說明；姓名搜尋（`audit-search.tsx`；B 階段 A-11 起由伺服器搜尋近 7 天全部紀錄，`?q=`）。
 * 只給管理員：頁面先 `requireRole`，查詢再判一次（非管理員拿到 null）；payload 不讀也不顯示
 * （唯一例外：核准註冊的核實說明，見 `application/ops/audit-log.ts` 檔頭）。
 */

function actorLabel(e: AuditLogEntry): string {
  if (e.actorKind === 'worker') return '背景工作'
  if (e.actorKind === 'system') return '系統'
  return e.actorName?.trim() || '（已不存在的帳號）'
}

/**
 * 新增、預授權老師這兩個動作，確認的對象一定是老師：顯示老師的文字，不提學生證（第三波 W6；
 * 同帳號頁新增老師對話框的 `teacherMethodLabel`，T6 系5）。只換顯示文字，紀錄裡的方式代碼不變。
 */
const TEACHER_ACTIONS: ReadonlySet<string> = new Set(['account.create_teacher', 'account.preauthorize_teacher'])
const TEACHER_METHOD_LABEL: typeof VERIFICATION_LABEL = {
  ...VERIFICATION_LABEL,
  id_document: '當面核對身分證件（教職員證、身分證）',
}

/** 核准註冊這類要確認本人的列：「怎麼確認是本人：當面核對學生證或其他身分證件／10/8 櫃台核對」。 */
function verificationText(e: AuditLogEntry): string | null {
  if (!e.verificationMethod) return null
  const note = e.verificationNote?.trim()
  const labels = TEACHER_ACTIONS.has(e.action) ? TEACHER_METHOD_LABEL : VERIFICATION_LABEL
  return `怎麼確認是本人：${labels[e.verificationMethod]}${note ? `／${note}` : ''}`
}

/** 角色分頁／清除鈕的網址；搜尋字跟著走。 */
function auditHref(role: AuditWhoFilter, q: string): string {
  const qs = new URLSearchParams()
  if (role !== 'all') qs.set('role', role)
  if (q) qs.set('q', q)
  const s = qs.toString()
  return s ? `${BASE}?${s}` : BASE
}

function tone(e: AuditLogEntry): 'brand' | 'default' | 'info' {
  const who = auditWhoOf(e)
  return who === 'admin' ? 'brand' : who === 'system' ? 'default' : 'info'
}

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole('/dashboard/admin/audit', 'admin')
  const params = await searchParams
  // 搜尋字在伺服器判：超過 50 字（`VALIDATION_FAILED`）就不搜、顯示說明；其餘照常。
  let log: Awaited<ReturnType<ReturnType<typeof getAuditLogQuery>['recent']>>
  let queryError: string | undefined
  try {
    log = await getAuditLogQuery().recent(actor, params.role, { q: Array.isArray(params.q) ? params.q[0] : params.q })
  } catch (e) {
    if (!(e instanceof AuditQueryInvalidError)) throw e
    queryError = e.message
    log = await getAuditLogQuery().recent(actor, params.role)
  }
  const q = log?.q ?? ''
  const who: AuditWhoFilter = log?.who ?? 'all'

  const rows: AuditSearchRow[] = (log?.entries ?? []).map((e) => ({
    id: e.id,
    node: (
      <li
        key={e.id}
        data-testid="audit-entry"
        className="grid items-start gap-3 border-b border-border px-5 py-3.5 last:border-0 md:grid-cols-[9rem_9rem_minmax(0,1fr)]"
      >
        <time dateTime={e.realAt.toISOString()} className="tabular text-xs text-muted-foreground">
          {formatTaipeiMinute(e.realAt)}
        </time>
        <span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-foreground">
          <span
            aria-hidden
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-subtle text-[10px] font-bold text-brand-on-subtle"
          >
            {actorLabel(e).slice(0, 1)}
          </span>
          <span className="truncate">{actorLabel(e)}</span>
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={tone(e)} title={auditActionTitle(e.action)}>
              {auditActionLabel(e.action)}
            </Pill>
            <span className="truncate text-sm text-foreground">{describeAuditTarget(e)}</span>
          </div>
          {verificationText(e) ? <p className="mt-1 text-sm break-words text-muted-foreground">{verificationText(e)}</p> : null}
          {e.reason?.trim() ? <p className="mt-1 text-sm break-words text-muted-foreground">理由：{e.reason}</p> : null}
        </div>
      </li>
    ),
  }))

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current={BASE}>
      {/* 分頁列自帶下方間距（`mb-5`），所以標題＋分頁列在外層，內容另一層 `gap-5`（同 AD-12 的屆別、時間軸）。 */}
      <div>
        <PageTitle title="設定" />
        <div className="mt-3">
          <AdminTabs label="設定分頁" current={BASE} items={SETTINGS_TABS} />
        </div>
        <div className="flex flex-col gap-5">
          {log ? (
            // 角色篩選是分頁列下的膠囊（設計方案 §3.6）；仍是網址（`?role=`），重新整理不會丟。
            <nav aria-label="依角色篩選" className="inline-flex max-w-full gap-1 self-start overflow-x-auto rounded-xl border border-border bg-card p-1">
              {AUDIT_WHO_FILTERS.map((key) => {
                const on = who === key
                return (
                  <Link
                    key={key}
                    href={auditHref(key, q)}
                    aria-current={on ? 'page' : undefined}
                    className={cn(
                      'inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-3 text-sm font-semibold whitespace-nowrap transition-colors',
                      on ? 'bg-ink text-ink-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                    )}
                  >
                    {AUDIT_WHO_LABEL[key]}{' '}
                    <span className={cn('tabular text-xs font-medium', on ? 'text-ink-foreground/80' : 'text-muted-foreground')}>{log.counts[key]}</span>
                  </Link>
                )
              })}
            </nav>
          ) : null}
          <Panel title="操作清單" icon={<IconHistory />} aria-label="操作清單">
            {!log ? (
              <PanelEmpty title="讀不到操作紀錄" hint="請重新整理頁面；一直這樣請通知維運。" />
            ) : (
              <div className="flex flex-col">
                {/* 搜尋框下這句是 Q113 定案的範圍說明，也是 `pages.spec` 的指紋：整句一個字串，不拆成多段文字節點。 */}
                <AuditSearch
                  rows={rows}
                  note={`只搜近 ${AUDIT_WINDOW_DAYS} 天、最多 ${AUDIT_PAGE_LIMIT} 筆（在伺服器搜尋）`}
                  emptyText="這個角色最近沒有操作。"
                  q={q}
                  role={who}
                  maxLength={AUDIT_QUERY_MAX_LENGTH}
                  clearHref={auditHref(who, '')}
                  error={queryError}
                />
                {log.truncated ? (
                  <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
                    只列最近 {AUDIT_PAGE_LIMIT} 筆；更早的紀錄仍保存在系統裡、不會被刪除。
                  </p>
                ) : null}
              </div>
            )}
          </Panel>
        </div>
      </div>
    </DashboardShell>
  )
}
