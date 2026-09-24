import Link from 'next/link'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { EmptyState, PageHeader } from '@/app/_ui/primitives'
import { VersionView } from '@/app/dashboard/_signoff/version-view'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { getSignoffQuery } from '@/composition/signoff'

export const metadata = { title: '簽核版本｜資管系專題平台' }

/**
 * 管理員的簽核版本頁（票 25／S11-04「版本頁」）：全文、附件、授權範圍（列在全文之後）、參與者、版本歷史，
 * 以及「站內內容確認與同意紀錄，行政採認待確認」標示。版本內容寫了就不能改，這一頁沒有任何編輯入口。
 */
export default async function AdminSignoffVersionPage({ params }: { params: Promise<{ versionId: string }> }) {
  const { versionId } = await params
  const actor = await requireRole(`/dashboard/admin/signoff/${versionId}`, 'admin')
  const detail = await getSignoffQuery().versionDetail(actor, versionId)

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/signoff">
      <PageHeader title="簽核版本" description="版本內容建立後不能改；要改就回簽核頁再建一版。" />
      <Link href="/dashboard/admin/signoff" className="mb-4 inline-block text-sm font-medium text-primary underline-offset-2 hover:underline">
        ← 回簽核
      </Link>
      {detail.ok ? (
        <VersionView v={detail.receipt} historyHref={(id) => `/dashboard/admin/signoff/${id}`} />
      ) : (
        <EmptyState title="找不到這個簽核版本" description={detail.message} action={{ href: '/dashboard/admin/signoff', label: '回簽核' }} />
      )}
    </DashboardShell>
  )
}
