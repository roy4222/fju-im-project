import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { IconArrowLeft } from '@tabler/icons-react'
import { requireRole } from '@/app/_ui/guard'
import { PageTitle } from '@/app/_ui/dashboard-primitives'
import { DashboardShell } from '@/app/_ui/site-shell'
import { EmptyState } from '@/app/_ui/primitives'
import { RespondForm } from '@/app/dashboard/_signoff/respond-form'
import { MyResponse } from '@/app/dashboard/_signoff/version-view'
import { STUDENT_NAV } from '@/app/dashboard/_nav'
import { studentSignoff } from '@/app/dashboard/student/_todo/todos'
import { ConsentVersion } from '@/app/dashboard/student/signoff/consent-view'
import { BUTTON_TEXT, MAX_REASON_CHARS } from '@/composition/signoff'

export const metadata = { title: '同意書｜資管系專題平台' }

/**
 * 學生「同意書」（票 25、26；ST-8 換成原型 `student-consent` 版型）：自己**此刻所在組別**每個簽核包的目前那一版——
 * 左邊全文、附件、授權範圍與本人的表態（勾「已完整閱讀」→「我已閱讀並同意」→ 確認框；或不同意並填理由），右邊「全組表態」。
 * 不在側欄：從交作業的同意書卡（`?version=<versionId>`）進來，所以頁首有回「交作業」的連結。
 * 誰是本人由登入者決定，別組的版本這裡拿不到（版本頁的讀取邊界見 `SignoffQuery.versionDetail`）。
 *
 * 版本因組員或主指導變更而失效時，上方顯示原因與「等待管理員建立新版」，沒有表態按鈕；
 * 系辦建好新版後重新整理，這裡就換成新版（目前版本才會出現在這一頁）。
 *
 * C1-11：連到同意書作業的版本（`itemId` 不是 null）轉到作業頁 `/dashboard/student/affairs/<itemId>?tab=status`；
 * 這一頁只剩舊 API 建的包（沒連作業）。
 */
export default async function StudentSignoffPage({ searchParams }: { searchParams: Promise<{ version?: string | string[] }> }) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole('/dashboard/student/signoff', 'student')
  // 跟側欄徽章、交作業列表讀同一份（ST-1 的 seam，同一次請求只查一次）。
  const view = await studentSignoff(actor.userId)
  const versions = pick(view.versions, (await searchParams).version)
  // 連到同意書作業的版本（C1-11）：表態搬到作業頁的「狀態」分頁；交作業的同意書卡、通知的舊連結都轉過去。
  const linked = versions.length === 1 ? versions[0]!.itemId : null
  if (linked) redirect(`/dashboard/student/affairs/${linked}?tab=status`)

  return (
    <DashboardShell roleLabel="學生" items={STUDENT_NAV} current="/dashboard/student/signoff">
      <div className="flex flex-col gap-5">
        <Link
          href="/dashboard/student/affairs"
          className="inline-flex w-fit items-center gap-1 rounded-md text-[13px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
        >
          <IconArrowLeft className="size-4" aria-hidden /> 交作業
        </Link>
        {/* 只看一版時標題就是那一版（G01・最終文件授權）；空的或好幾版時頁面另有一個 h1。 */}
        {versions.length === 1 ? null : <PageTitle title="同意書" />}
        {versions.length === 0 ? (
          <EmptyState
            title="目前沒有待處理的同意書"
            description={
              view.groupCode
                ? `系辦還沒有替 ${view.groupCode} 建立站內同意書。建好時你會在通知匣收到「輪到你同意」。`
                : '你目前不在任何組別裡；分組成立、系辦建立站內同意書後才會出現在這裡。'
            }
            action={view.groupCode ? undefined : { href: '/dashboard/student/groups', label: '前往我的組別' }}
          />
        ) : (
          versions.map((v) => (
            <ConsentVersion
              key={v.versionId}
              v={v}
              headingLevel={versions.length === 1 ? 1 : 2}
              action={
                v.viewer.role === null ? null : (
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
                )
              }
            />
          ))
        )}
        <p className="text-xs text-muted-foreground">每個人只代表自己一票；全部組員同意後才輪到指導老師。任何人都不能替別人同意，系辦也不行；投了不能改。</p>
      </div>
    </DashboardShell>
  )
}

/**
 * 交作業的同意書卡帶 `?version=<versionId>` 進來 → 只看那一版；沒帶、或那一版不是本組簽核包目前的版本（舊連結）→ 列出每個簽核包目前那一版。
 * 失效／作廢但指標還指著它的版本仍在清單裡，所以從舊連結進來看得到 `signoff-invalidated` 的說明。
 */
function pick<T extends { versionId: string }>(versions: readonly T[], version: string | string[] | undefined): readonly T[] {
  const id = typeof version === 'string' ? version : undefined
  const hit = id ? versions.filter((v) => v.versionId === id) : []
  return hit.length > 0 ? hit : versions
}
