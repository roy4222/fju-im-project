import Link from 'next/link'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { EmptyState, PageHeader } from '@/app/_ui/primitives'
import { VersionView } from '@/app/dashboard/_signoff/version-view'
import { TEACHER_NAV } from '@/app/dashboard/_nav'
import { getSignoffQuery } from '@/composition/signoff'

export const metadata = { title: '簽核版本｜資管系專題平台' }

/**
 * 老師的簽核版本頁（票 25）：這一版的參與者主指導、或這一組此刻的主指導讀得到；其他老師一律「無法存取」
 * （不透露版本存不存在）。老師同意／退回在票 26。
 */
export default async function TeacherSignoffVersionPage({ params }: { params: Promise<{ versionId: string }> }) {
  const { versionId } = await params
  const actor = await requireRole(`/dashboard/teacher/signoff/${versionId}`, 'teacher')
  const detail = await getSignoffQuery().versionDetail(actor, versionId)

  return (
    <DashboardShell roleLabel="老師" items={TEACHER_NAV} current="/dashboard/teacher/signoff">
      <PageHeader title="簽核版本" description="全文、附件、授權範圍與參與者；全部學生同意後才輪到你。" />
      <Link href="/dashboard/teacher/signoff" className="mb-4 inline-block text-sm font-medium text-primary underline-offset-2 hover:underline">
        ← 回簽核
      </Link>
      {detail.ok ? (
        <VersionView
          v={detail.receipt}
          historyHref={(id) => `/dashboard/teacher/signoff/${id}`}
          footnote="老師的「同意」與「退回」在下一階段開放；要等全部學生同意後才能按。"
        />
      ) : (
        <EmptyState title="無法存取" description="這不是你此刻指導的組別的簽核版本。" action={{ href: '/dashboard/teacher/signoff', label: '回簽核' }} />
      )}
    </DashboardShell>
  )
}
