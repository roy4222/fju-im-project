import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { EmptyState, PageHeader } from '@/app/_ui/primitives'
import { RespondForm } from '@/app/dashboard/_signoff/respond-form'
import { MyResponse, VersionView } from '@/app/dashboard/_signoff/version-view'
import { TEACHER_NAV } from '@/app/dashboard/_nav'
import { BUTTON_TEXT, getSignoffQuery, MAX_REASON_CHARS } from '@/composition/signoff'

export const metadata = { title: '簽核版本｜資管系專題平台' }

/**
 * 老師的簽核版本頁（票 25、26）：這一版的參與者主指導、或這一組此刻的主指導讀得到；其他老師一律「無法存取」
 * （不透露版本存不存在）。全部學生同意後，快照裡的主指導（此刻仍是主指導）在這裡同意或退回；
 * 學生還沒全同意時沒有按鈕，只寫還差幾位（伺服器也會擋，`STUDENTS_PENDING`）。
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
          action={
            <MyResponse
              v={detail.receipt}
              form={
                <RespondForm
                  versionId={detail.receipt.versionId}
                  contentChecksum={detail.receipt.contentChecksum}
                  requestId={randomUUID()}
                  role="advisor"
                  agreeText={BUTTON_TEXT.advisor.agree}
                  rejectText={BUTTON_TEXT.advisor.reject}
                  reasonMaxLength={MAX_REASON_CHARS}
                />
              }
            />
          }
        />
      ) : (
        <EmptyState title="無法存取" description="這不是你此刻指導的組別的簽核版本。" action={{ href: '/dashboard/teacher/signoff', label: '回簽核' }} />
      )}
    </DashboardShell>
  )
}
