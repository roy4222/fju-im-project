import Link from 'next/link'
import { IconHistory } from '@tabler/icons-react'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { PageTitle, Panel, PanelEmpty, Pill } from '@/app/_ui/dashboard/primitives'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import type { AuditLogEntry, AuditWhoFilter } from '@/application/ops'
import {
  AUDIT_PAGE_LIMIT,
  AUDIT_WHO_FILTERS,
  AUDIT_WHO_LABEL,
  AUDIT_WINDOW_DAYS,
  auditActionLabel,
  auditWhoOf,
  describeAuditTarget,
  getAuditLogQuery,
} from '@/composition/ops'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute } from '@/shared/time'

export const metadata = { title: '操作紀錄｜資管系專題平台' }

const BASE = '/dashboard/admin/audit'

/**
 * 管理員「操作紀錄」（票 36；原型 `/dashboard/admin/audit`；模組 10「依角色篩選，每筆有時間、人、動作、對象、理由；不可修改」）。
 *
 * 資料是既有的稽核紀錄（`audit_events`），這一頁只讀、沒有任何修改入口。一頁一個焦點＝清單，數字放標題下一行。
 * 角色分頁用網址（`?role=`）：重新整理不會丟，也不用在瀏覽器裝整份資料。
 * 只給管理員：頁面先 `requireRole`，查詢再判一次（非管理員拿到 null）；payload 不讀也不顯示。
 */

function actorLabel(e: AuditLogEntry): string {
  if (e.actorKind === 'worker') return '背景工作'
  if (e.actorKind === 'system') return '系統'
  return e.actorName?.trim() || '（已不存在的帳號）'
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
  const log = await getAuditLogQuery().recent(actor, params.role)
  const who: AuditWhoFilter = log?.who ?? 'all'

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current={BASE}>
      <div className="flex flex-col gap-5">
        <PageTitle
          title="操作紀錄"
          description={
            log
              ? `近 ${AUDIT_WINDOW_DAYS} 天 ${log.counts.all} 筆・管理員操作 ${log.counts.admin} 筆・附理由 ${log.withReason} 筆（重開、更正、例外都必填）。誰、何時、對哪個對象、做了什麼、為什麼；不可修改。`
              : '誰、何時、對哪個對象、做了什麼、為什麼；不可修改。'
          }
        />
        <Panel title="事件" icon={<IconHistory />} aria-label="事件">
          {!log ? (
            <PanelEmpty title="讀不到操作紀錄" hint="請重新整理頁面；一直這樣請通知維運。" />
          ) : (
            <div className="flex flex-col">
              <nav className="flex flex-wrap items-center gap-1 border-b border-border px-3" aria-label="依角色篩選">
                {AUDIT_WHO_FILTERS.map((key) => {
                  const on = who === key
                  return (
                    <Link
                      key={key}
                      href={key === 'all' ? BASE : `${BASE}?role=${key}`}
                      aria-current={on ? 'page' : undefined}
                      className={cn(
                        'relative inline-flex h-10 items-center gap-1 px-3 text-sm font-semibold transition-colors',
                        on ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {AUDIT_WHO_LABEL[key]} <span className="tabular text-xs font-medium text-muted-foreground">{log.counts[key]}</span>
                      <span
                        aria-hidden
                        className={cn(
                          'absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-brand transition-transform duration-150',
                          on ? 'scale-x-100' : 'scale-x-0',
                        )}
                      />
                    </Link>
                  )
                })}
              </nav>
              <ol aria-label="操作紀錄清單">
                {log.entries.map((e) => (
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
                        <Pill tone={tone(e)}>{auditActionLabel(e.action)}</Pill>
                        <span className="truncate text-sm text-foreground">{describeAuditTarget(e)}</span>
                      </div>
                      {e.reason?.trim() ? <p className="mt-1 text-sm break-words text-muted-foreground">理由：{e.reason}</p> : null}
                    </div>
                  </li>
                ))}
                {log.entries.length === 0 ? (
                  <li className="px-5 py-8 text-center text-sm text-muted-foreground">這個角色最近沒有操作。</li>
                ) : null}
              </ol>
              {log.truncated ? (
                <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
                  只列最近 {AUDIT_PAGE_LIMIT} 筆；更早的紀錄仍保存在系統裡、不會被刪除。
                </p>
              ) : null}
            </div>
          )}
        </Panel>
      </div>
    </DashboardShell>
  )
}
