import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { EmptyState, PageHeader } from '@/app/_ui/primitives'
import { VersionView } from '@/app/dashboard/_signoff/version-view'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { RemindButton, RestartButton, VoidButton } from '@/app/dashboard/admin/signoff/manage-forms'
import type { VersionDetail } from '@/application/signoff'
import { getSignoffQuery, MAX_REASON_CHARS, nextRemindAt, RESTART_LABEL, restartKindFor, VOTE_RESULT_LABEL } from '@/composition/signoff'
import { formatTaipeiMinute } from '@/shared/time'

export const metadata = { title: '簽核版本｜資管系專題平台' }

/**
 * 管理員的簽核版本頁（票 25、26）：全文、附件、授權範圍、逐人進度與缺誰、版本歷史，以及系辦能做的事——
 * 提醒未同意者（24 小時一次）、重置或重開新版、作廢（理由必填）、匯出可列印頁與 CSV（每次匯出都留紀錄）。
 * 版本內容寫了就不能改；**沒有任何替人表態的入口**。
 */

const FORMAT_LABEL = { printable: '可列印頁', csv: 'CSV 明細' } as const

function remindBlocked(v: VersionDetail, now: Date): string | null {
  if (!v.isCurrent || (v.state !== 'collecting' && v.state !== 'teacher_pending')) return '只有收集中或等老師的目前版本可以提醒。'
  const next = nextRemindAt(v.lastRemindedAt, now)
  if (v.lastRemindedAt && next) return `已於 ${formatTaipeiMinute(v.lastRemindedAt)} 提醒，${formatTaipeiMinute(next)} 之後可以再提醒。`
  return null
}

/** 重置／重開時將失效（不計入新版）的簽署。 */
function affectedVotes(v: VersionDetail): string[] {
  const p = v.progress
  return [...p.students, p.advisor].filter((x) => x.result !== null).map((x) => `${x.displayName}（${VOTE_RESULT_LABEL[x.result!]}）`)
}

function Manage({ v }: { v: VersionDetail }) {
  const kind = restartKindFor(v.state)
  return (
    <section aria-label="系辦管理" className="space-y-4 rounded-md border border-border p-4" data-testid="signoff-manage">
      <h3 className="text-sm font-semibold text-ink">系辦管理</h3>
      {v.isCurrent ? (
        <div className="flex flex-wrap items-start gap-4">
          <RemindButton versionId={v.versionId} requestId={randomUUID()} blockedReason={remindBlocked(v, new Date())} />
          <RestartButton
            versionId={v.versionId}
            requestId={randomUUID()}
            kind={kind}
            label={RESTART_LABEL[kind]}
            affected={v.state === 'complete' || v.state === 'superseded' || v.state === 'void' ? [] : affectedVotes(v)}
            reasonMaxLength={MAX_REASON_CHARS}
          />
          {v.state !== 'void' ? <VoidButton versionId={v.versionId} requestId={randomUUID()} reasonMaxLength={MAX_REASON_CHARS} /> : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">這不是目前的版本，只能查看與匯出；要處理請到目前那一版。</p>
      )}

      <div className="space-y-2 border-t border-border pt-3">
        <p className="text-sm font-medium text-ink">匯出同意紀錄</p>
        <div className="flex flex-wrap gap-2">
          {(['printable', 'csv'] as const).map((format) => (
            <form key={format} method="post" action={`/api/admin/signoff/${v.versionId}/export`} target="_blank">
              <input type="hidden" name="format" value={format} />
              <button type="submit" className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-sm font-medium text-ink hover:bg-muted">
                匯出{FORMAT_LABEL[format]}
              </button>
            </form>
          ))}
        </div>
        {v.exports.length > 0 ? (
          <ul className="space-y-1 text-xs text-muted-foreground" data-testid="signoff-exports">
            {v.exports.map((e, i) => (
              <li key={i}>
                {formatTaipeiMinute(e.at)}・{e.byName}・{FORMAT_LABEL[e.format]}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">還沒有匯出過。每次匯出都會留一筆紀錄。</p>
        )}
      </div>
    </section>
  )
}

export default async function AdminSignoffVersionPage({
  params,
  searchParams,
}: {
  params: Promise<{ versionId: string }>
  searchParams: Promise<{ restarted?: string; from?: string }>
}) {
  const { versionId } = await params
  const { restarted, from } = await searchParams
  const actor = await requireRole(`/dashboard/admin/signoff/${versionId}`, 'admin')
  const detail = await getSignoffQuery().versionDetail(actor, versionId)

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/signoff">
      <PageHeader title="簽核版本" description="版本內容建立後不能改；要改就回簽核頁再建一版。系辦不能替任何人表態。" />
      <Link href="/dashboard/admin/signoff" className="mb-4 inline-block text-sm font-medium text-primary underline-offset-2 hover:underline">
        ← 回簽核
      </Link>
      {detail.ok && (restarted === 'reset' || restarted === 'reopen') ? (
        <p role="status" className="mb-4 rounded-md bg-primary-subtle px-4 py-3 text-sm text-primary-on-subtle">
          已{RESTART_LABEL[restarted]}：這是新建的 v{detail.receipt.versionNo}
          {/^\d+$/.test(from ?? '') ? `（內容與 v${from} 相同）` : ''}，參與者依此刻重新計算；舊版與舊的表態留作歷史、不計入新版，
          每位參與學生已收到「輪到你同意」。
        </p>
      ) : null}
      {detail.ok ? (
        <VersionView v={detail.receipt} historyHref={(id) => `/dashboard/admin/signoff/${id}`} action={<Manage v={detail.receipt} />} />
      ) : (
        <EmptyState title="找不到這個簽核版本" description={detail.message} action={{ href: '/dashboard/admin/signoff', label: '回簽核' }} />
      )}
    </DashboardShell>
  )
}
