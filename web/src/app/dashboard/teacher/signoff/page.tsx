import Link from 'next/link'
import { IconArrowRight, IconSignature } from '@tabler/icons-react'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { TEACHER_NAV } from '@/app/dashboard/_nav'
import { OUTLINE_BUTTON_SM, PageTitle, Panel, PanelEmpty, Pill, PRIMARY_BUTTON, type PillTone } from '@/app/dashboard/teacher/_ui/dash'
import type { TeacherSignoffCard } from '@/application/signoff'
import { describeCause, getSignoffQuery, PURPOSE_LABEL, STATE_LABEL } from '@/composition/signoff'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute } from '@/shared/time'

export const metadata = { title: '簽核｜資管系專題平台' }

/** 輪到這位老師表態：學生都同意了、他是快照裡的主指導、還沒投。 */
const isMyTurn = (c: TeacherSignoffCard) => c.current.state === 'teacher_pending' && c.mine.isSnapshotAdvisor && !c.mine.voted

/** 一列的狀態字（原型「輪到你」「等待學生」「完成」「退回修正」；產品 07：「等待學生 2 人」）。 */
function cardStatus(c: TeacherSignoffCard): { text: string; tone: PillTone } {
  const p = c.current.progress
  switch (c.current.state) {
    case 'collecting':
      return { text: `等待學生 ${p.total - p.agreed} 位`, tone: 'default' }
    case 'teacher_pending':
      return c.mine.isSnapshotAdvisor ? { text: '輪到你', tone: 'brand' } : { text: '學生都已同意，等主指導', tone: 'default' }
    case 'complete':
      return { text: '已完成', tone: 'success' }
    case 'revision':
      return { text: '已退回修正', tone: 'brand' }
    default:
      return { text: STATE_LABEL[c.current.state], tone: 'default' }
  }
}

/** 列的第二行：誰還沒同意、版本、何時建立。 */
function cardDetail(c: TeacherSignoffCard): string {
  const v = c.current
  const p = v.progress
  const waiting = p.students.filter((s) => s.result === null).map((s) => s.displayName)
  const head = `v${v.versionNo}・${c.cohortCode}`
  switch (v.state) {
    case 'collecting':
      return `學生 ${p.agreed}／${p.total} 已同意${waiting.length ? `・還沒：${waiting.join('、')}` : ''}・${head}`
    case 'teacher_pending':
      return `學生 ${p.agreed}／${p.total} 已同意・${head}・${isMyTurn(c) ? '等你' : '等主指導'}`
    case 'complete':
      return `學生 ${p.total}／${p.total}・老師已同意・${head}`
    case 'revision':
      return `已退回，等系辦重開新版後全組重走一次・${head}`
    case 'superseded':
      return `已失效（${describeCause(v.cause) ?? '—'}），等待系辦建立新版・${head}`
    default:
      return `${head}・${formatTaipeiMinute(v.createdAt)} 建立`
  }
}

/**
 * 老師「簽核」（票 25、26；票 37 照原型 `/dashboard/teacher/signoff`）：**此刻**指導的每一組、每個簽核包的目前那一版一列，
 * 換掉的老師這裡就看不到那一組（查詢只看有效的主指導）。
 *
 * 原型在列表上直接放「我已閱讀並同意／不同意」；正式碼照產品 07（老師要先讀到全文）把表態留在版本頁：
 * 輪到你的那一列是橘色「閱讀全文並表態」，其他列是「閱讀全文與進度」。學生全員同意後按鈕才會出現（伺服器也會擋）。
 */
export default async function TeacherSignoffPage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole('/dashboard/teacher/signoff', 'teacher')
  const cards = await getSignoffQuery().teacherView(actor)
  const rank = (c: TeacherSignoffCard) => (isMyTurn(c) ? 0 : c.current.state === 'collecting' ? 1 : c.current.state === 'teacher_pending' ? 2 : 3)
  const rows = [...cards].sort((a, b) => rank(a) - rank(b) || a.groupCode.localeCompare(b.groupCode))
  const ready = cards.filter(isMyTurn).length
  const waiting = cards.filter((c) => c.current.state === 'collecting').length
  const complete = cards.filter((c) => c.current.state === 'complete').length

  return (
    <DashboardShell roleLabel="老師" items={TEACHER_NAV} current="/dashboard/teacher/signoff">
      <div className="flex flex-col gap-5">
        <PageTitle title="簽核" description="你此刻指導的組別的簽核版本與進度。全部學生同意後才輪到你。" />
        {cards.length > 0 ? (
          <p className="tabular text-sm">
            <b className={ready ? 'text-primary' : 'text-foreground'}>待我同意 {ready} 份</b>
            <span className="text-muted-foreground">
              ・等待學生 {waiting} 份・完成 {complete} 份
            </span>
          </p>
        ) : null}
        <Panel title="我的指導組別" icon={<IconSignature />} description={`${rows.length} 份`}>
          {rows.length === 0 ? (
            <PanelEmpty
              icon={<IconSignature />}
              title="目前沒有待處理的簽核"
              hint="你指導的組別還沒有簽核版本。系辦建好後，組員先各自同意，全部同意後才會輪到你。"
              action={{ href: '/dashboard/teacher/groups', label: '看我指導的組別' }}
            />
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((c) => {
                const status = cardStatus(c)
                const mine = isMyTurn(c)
                const href = `/dashboard/teacher/signoff/${c.current.versionId}`
                return (
                  <li
                    key={c.current.versionId}
                    data-testid="teacher-signoff-card"
                    className={cn(
                      'grid items-center gap-x-4 gap-y-3 px-5 py-4 md:grid-cols-[minmax(0,1fr)_auto]',
                      mine && 'border-l-[3px] border-l-primary',
                    )}
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="tabular text-xs font-semibold text-muted-foreground">{c.groupCode}</span>
                        <Pill tone={status.tone} testId="teacher-card-status">
                          {status.text}
                        </Pill>
                      </div>
                      <p className="truncate text-[15px] font-semibold text-foreground">
                        {c.groupCode}・{PURPOSE_LABEL[c.purpose]}
                      </p>
                      <p className="tabular mt-0.5 text-xs text-muted-foreground">
                        {STATE_LABEL[c.current.state]}・{cardDetail(c)}
                      </p>
                    </div>
                    <div className="md:justify-self-end">
                      {mine ? (
                        <Link href={href} className={PRIMARY_BUTTON}>
                          閱讀全文並表態
                          <IconArrowRight />
                        </Link>
                      ) : (
                        <Link href={href} className={OUTLINE_BUTTON_SM}>
                          閱讀全文與進度
                        </Link>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </Panel>
      </div>
    </DashboardShell>
  )
}
