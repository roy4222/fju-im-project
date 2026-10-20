import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { EmptyState, PageHeader } from '@/app/_ui/primitives'
import { VersionView } from '@/app/dashboard/_signoff/version-view'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import type { VersionDetail } from '@/application/signoff'
import { getSignoffQuery } from '@/composition/signoff'
import { formatTaipeiMinute } from '@/shared/time'

export const metadata = { title: '同意書內容｜資管系專題平台' }

/**
 * 管理員的簽核版本頁（票 25、26）：全文、附件、授權範圍、逐人進度與缺誰、版本歷史，以及匯出可列印頁與 CSV（每次匯出都留紀錄）。
 * 版本內容寫了就不能改；**沒有任何替人表態的入口**。
 *
 * C1-11：連到同意書作業的版本一律轉到該作業的繳交狀況（同意書看板，操作都在那裡）；
 * 只剩舊 API 建的包（沒連作業）會留在這一頁，而且**唯讀**——只顯示狀態與匯出，不放提醒、重新收集、重開、作廢。
 */

const FORMAT_LABEL = { printable: '可列印頁', csv: 'CSV 明細' } as const

/**
 * 舊同意書包（沒連到作業，`item_id is null`）只能查看與匯出（C1-11、issue #652「舊包顯示唯讀」）：
 * 不放提醒、重新收集、重開、作廢；要重新收集同意請改用作業分頁「新增 › 同意書（站內表單）」。
 */
function ReadOnly({ v }: { v: VersionDetail }) {
  return (
    <section aria-label="系辦管理" className="space-y-4 rounded-lg border border-border p-4" data-testid="signoff-manage">
      <h3 className="text-sm font-semibold text-foreground">系辦管理</h3>
      <p className="text-sm text-muted-foreground" data-testid="signoff-readonly">
        這是舊版同意書（沒有連到作業），只能查看與匯出。要重新收集同意，請到「公告與作業 › 作業」新增站內同意書。
      </p>
      <div className="space-y-2 border-t border-border pt-3">
        <p className="text-sm font-medium text-foreground">匯出同意紀錄</p>
        <div className="flex flex-wrap gap-2">
          {(['printable', 'csv'] as const).map((format) => (
            <form key={format} method="post" action={`/api/admin/signoff/${v.versionId}/export`} target="_blank">
              <input type="hidden" name="format" value={format} />
              <button type="submit" className="inline-flex items-center rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted">
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

export default async function AdminSignoffVersionPage({ params }: { params: Promise<{ versionId: string }> }) {
  const { versionId } = await params
  const actor = await requireRole(`/dashboard/admin/signoff/${versionId}`, 'admin')
  // 舊網址轉址（C1-11、§6.3、AC-21c）：連到同意書作業的版本 → 那份作業的繳交狀況（同意書看板）；
  // 舊 API 建的包（`item_id is null`）或找不到 → 留在這一頁。
  const linked = await getSignoffQuery().itemOfVersion(actor, versionId)
  if (linked.ok && linked.receipt.itemId) redirect(`/dashboard/admin/affairs/${linked.receipt.itemId}`)
  const detail = await getSignoffQuery().versionDetail(actor, versionId)

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/signoff">
      <PageHeader title="同意書內容" description="舊版同意書只能查看與匯出。系辦不能替任何人回覆。" />
      <Link href="/dashboard/admin/signoff" className="mb-4 inline-block text-sm font-medium text-primary underline-offset-2 hover:underline">
        ← 回同意書
      </Link>
      {detail.ok ? (
        <VersionView v={detail.receipt} historyHref={(id) => `/dashboard/admin/signoff/${id}`} action={<ReadOnly v={detail.receipt} />} />
      ) : (
        <EmptyState title="找不到這份同意書" description={detail.message} action={{ href: '/dashboard/admin/signoff', label: '回同意書' }} />
      )}
    </DashboardShell>
  )
}
