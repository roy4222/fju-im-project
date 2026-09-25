import { randomUUID } from 'node:crypto'
import { IconSignature } from '@tabler/icons-react'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { RespondForm } from '@/app/dashboard/_signoff/respond-form'
import { MyResponse, VersionView } from '@/app/dashboard/_signoff/version-view'
import { TEACHER_NAV } from '@/app/dashboard/_nav'
import { BackLink, PageTitle, Panel, PanelEmpty } from '@/app/dashboard/teacher/_ui/dash'
import { BUTTON_TEXT, getSignoffQuery, MAX_REASON_CHARS } from '@/composition/signoff'

export const metadata = { title: '簽核版本｜資管系專題平台' }

/**
 * 老師的簽核版本頁（票 25、26）：只有這一組**此刻**的主指導讀得到；快照裡的主指導若已被換掉就看不到
 * （產品 07 §8；2026-09-25 Roy 定：換老師後舊老師失權含看不到；規則在 `canReadSignoffVersions`）。
 * 其他老師一律「無法存取」（不透露版本存不存在）。全部學生同意後，快照裡的主指導（此刻仍是主指導）在這裡同意或退回；
 * 學生還沒全同意時沒有按鈕，只寫還差幾位（伺服器也會擋，`STUDENTS_PENDING`）。
 *
 * 票 37：原型沒有這一頁（原型在列表上直接表態）；頁首與返回連結照原型子頁的樣子，版本內容與表態表單沿用三個角色共用的元件。
 */
export default async function TeacherSignoffVersionPage({ params }: { params: Promise<{ versionId: string }> }) {
  const { versionId } = await params
  const actor = await requireRole(`/dashboard/teacher/signoff/${versionId}`, 'teacher')
  const detail = await getSignoffQuery().versionDetail(actor, versionId)

  return (
    <DashboardShell roleLabel="老師" items={TEACHER_NAV} current="/dashboard/teacher/signoff">
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-3">
          <BackLink href="/dashboard/teacher/signoff">回簽核</BackLink>
          <PageTitle title="簽核版本" description="全文、附件、授權範圍與參與者；全部學生同意後才輪到你。" />
        </div>
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
          <Panel title="簽核版本" icon={<IconSignature />}>
            <PanelEmpty
              icon={<IconSignature />}
              title="無法存取"
              hint="這不是你此刻指導的組別的簽核版本。"
              action={{ href: '/dashboard/teacher/signoff', label: '回簽核' }}
            />
          </Panel>
        )}
      </div>
    </DashboardShell>
  )
}
