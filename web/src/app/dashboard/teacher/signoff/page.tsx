import Link from 'next/link'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { EmptyState, PageHeader } from '@/app/_ui/primitives'
import { StateBadge } from '@/app/dashboard/_signoff/version-view'
import { TEACHER_NAV } from '@/app/dashboard/_nav'
import type { TeacherSignoffCard } from '@/application/signoff'
import { describeCause, getSignoffQuery, PURPOSE_LABEL, STATE_LABEL } from '@/composition/signoff'
import { formatTaipeiMinute } from '@/shared/time'

export const metadata = { title: '簽核｜資管系專題平台' }

/**
 * 老師「簽核」（票 25；原型 `/dashboard/teacher/signoff`）：**此刻**指導的每一組、每個簽核包的目前那一版一張卡，
 * 點進去讀全文、附件、授權範圍與參與者。換掉的老師這裡就看不到那一組（查詢只看有效的主指導）。
 *
 * 卡片寫「輪到你」「等待學生 N 位」「已完成」「已退回修正」；同意或退回在版本頁（學生全員同意後才出現按鈕）。
 */
/** 卡片的一句話狀態（原型「輪到你」「等待學生 2 人」）。 */
function cardStatus(c: TeacherSignoffCard): string {
  const p = c.current.progress
  switch (c.current.state) {
    case 'collecting':
      return `等待學生 ${p.total - p.agreed} 位`
    case 'teacher_pending':
      return c.mine.isSnapshotAdvisor ? '輪到你' : '學生都已同意，等主指導'
    case 'complete':
      return '已完成'
    case 'revision':
      return '已退回修正'
    default:
      return STATE_LABEL[c.current.state]
  }
}

export default async function TeacherSignoffPage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole('/dashboard/teacher/signoff', 'teacher')
  const cards = await getSignoffQuery().teacherView(actor)

  return (
    <DashboardShell roleLabel="老師" items={TEACHER_NAV} current="/dashboard/teacher/signoff">
      <PageHeader title="簽核" description="你此刻指導的組別的簽核版本與進度。全部學生同意後才輪到你。" />
      {cards.length === 0 ? (
        <EmptyState
          title="目前沒有待處理的簽核"
          description="你指導的組別還沒有簽核版本。系辦建好後，組員先各自同意，全部同意後才會輪到你。"
          action={{ href: '/dashboard/teacher/groups', label: '看我指導的組別' }}
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {cards.map((c) => {
            const cause = describeCause(c.current.cause)
            return (
              <li key={c.current.versionId} className="rounded-card border border-border bg-background p-4" data-testid="teacher-signoff-card">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-xs text-muted-foreground tabular-nums">{c.cohortCode}</p>
                    <h2 className="text-base font-semibold text-ink">
                      {c.groupCode}・{PURPOSE_LABEL[c.purpose]}
                    </h2>
                  </div>
                  <StateBadge state={c.current.state} />
                </div>
                <p className="mt-2 text-sm font-medium text-ink" data-testid="teacher-card-status">
                  {cardStatus(c)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  v{c.current.versionNo}・學生 {c.current.progress.agreed}／{c.current.progress.total} 已同意・
                  {formatTaipeiMinute(c.current.createdAt)} 建立
                  {c.current.state === 'superseded' && cause ? `・已失效（${cause}），等待系辦建立新版` : ''}
                </p>
                <Link
                  href={`/dashboard/teacher/signoff/${c.current.versionId}`}
                  className="mt-3 inline-block text-sm font-medium text-primary underline-offset-2 hover:underline"
                >
                  {c.current.state === 'teacher_pending' && c.mine.isSnapshotAdvisor && !c.mine.voted ? '閱讀全文並表態' : '閱讀全文與進度'}
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </DashboardShell>
  )
}
