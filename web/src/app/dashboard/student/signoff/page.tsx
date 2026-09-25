import { randomUUID } from 'node:crypto'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { EmptyState, PageHeader } from '@/app/_ui/primitives'
import { RespondForm } from '@/app/dashboard/_signoff/respond-form'
import { MyResponse, VersionView } from '@/app/dashboard/_signoff/version-view'
import { STUDENT_NAV } from '@/app/dashboard/_nav'
import { BUTTON_TEXT, getSignoffQuery, MAX_REASON_CHARS } from '@/composition/signoff'

export const metadata = { title: '簽核｜資管系專題平台' }

/**
 * 學生「簽核」（票 25、26；原型 `/dashboard/student/signoff`）：自己**此刻所在組別**每個簽核包的目前那一版——
 * 全文、附件、授權範圍、逐人進度，以及本人的表態（勾「已完整閱讀」→「我已閱讀並同意」→ 確認框；或不同意並填理由）。
 * 誰是本人由登入者決定，別組的版本這裡拿不到（版本頁的讀取邊界見 `SignoffQuery.versionDetail`）。
 *
 * 版本因組員或主指導變更而失效時，上方顯示原因與「等待管理員建立新版」，沒有表態按鈕；
 * 系辦建好新版後重新整理，這裡就換成新版（目前版本才會出現在這一頁）。
 */
export default async function StudentSignoffPage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole('/dashboard/student/signoff', 'student')
  const view = await getSignoffQuery().studentView(actor)

  return (
    <DashboardShell roleLabel="學生" items={STUDENT_NAV} current="/dashboard/student/signoff">
      <PageHeader title="簽核" description="你的組別要閱讀並同意的內容，每個人只代表自己一票；全部組員同意後才輪到指導老師。" />
      {view.versions.length === 0 ? (
        <EmptyState
          title="目前沒有待處理的簽核"
          description={
            view.groupCode
              ? `系辦還沒有替 ${view.groupCode} 建立簽核版本。建好時你會在通知匣收到「輪到你同意」。`
              : '你目前不在任何組別裡；分組成立、系辦建立簽核版本後才會出現在這裡。'
          }
          action={view.groupCode ? undefined : { href: '/dashboard/student/groups', label: '前往我的組別' }}
        />
      ) : (
        <div className="space-y-6">
          {view.versions.map((v) => (
            <VersionView
              key={v.versionId}
              v={v}
              action={
                <MyResponse
                  v={v}
                  form={
                    <RespondForm
                      versionId={v.versionId}
                      contentChecksum={v.contentChecksum}
                      requestId={randomUUID()}
                      role="student"
                      agreeText={BUTTON_TEXT.student.agree}
                      rejectText={BUTTON_TEXT.student.reject}
                      reasonMaxLength={MAX_REASON_CHARS}
                    />
                  }
                />
              }
            />
          ))}
        </div>
      )}
    </DashboardShell>
  )
}
