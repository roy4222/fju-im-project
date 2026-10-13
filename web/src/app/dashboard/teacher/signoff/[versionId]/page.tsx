import { randomUUID } from 'node:crypto'
import { redirect } from 'next/navigation'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { RespondForm } from '@/app/dashboard/_signoff/respond-form'
import { MyResponse, VersionView } from '@/app/dashboard/_signoff/version-view'
import { TEACHER_NAV } from '@/app/dashboard/_nav'
import { BackLink, PageTitle } from '@/app/dashboard/teacher/_ui/dash'
import { BUTTON_TEXT, getSignoffQuery, MAX_REASON_CHARS } from '@/composition/signoff'

export const metadata = { title: '同意書內容｜資管系專題平台' }

/**
 * 老師的簽核版本頁（票 25、26）：只有這一組**此刻**的主指導讀得到；快照裡的主指導若已被換掉就看不到
 * （產品 07 §8；2026-09-25 Roy 定：換老師後舊老師失權含看不到；規則在 `canReadSignoffVersions`）。
 * 其他老師、或版本不存在，一律導到 `/403`「找不到這個頁面」（不透露版本存不存在、也不說原因；2026-10-12 Roy Q35）。
 * 全部學生同意後，快照裡的主指導（此刻仍是主指導）在這裡同意或退回；
 * 學生還沒全同意時沒有按鈕，只寫還差幾位（伺服器也會擋，`STUDENTS_PENDING`）。
 *
 * 票 37：原型沒有這一頁（原型在列表上直接表態）；頁首與返回連結照原型子頁的樣子，版本內容與表態表單沿用三個角色共用的元件。
 */
export default async function TeacherSignoffVersionPage({ params }: { params: Promise<{ versionId: string }> }) {
  const { versionId } = await params
  const actor = await requireRole(`/dashboard/teacher/signoff/${versionId}`, 'teacher')
  const detail = await getSignoffQuery().versionDetail(actor, versionId)
  if (!detail.ok) redirect('/403')

  return (
    <DashboardShell roleLabel="老師" items={TEACHER_NAV} current="/dashboard/teacher/signoff">
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-3">
          <BackLink href="/dashboard/teacher/signoff">回站內同意書</BackLink>
          <PageTitle title="同意書內容" description="全文、附件、授權範圍與參與者；全部學生同意後才輪到你。" />
        </div>
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
      </div>
    </DashboardShell>
  )
}
