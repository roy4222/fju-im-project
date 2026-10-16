import Link from 'next/link'
import { IconArrowRight, IconSignature } from '@tabler/icons-react'
import { OUTLINE_BUTTON_SM, Panel, PanelEmpty, Pill, PRIMARY_BUTTON, type PillTone } from '@/app/dashboard/teacher/_ui/dash'
import { teacherSignoffSummary } from '@/app/dashboard/teacher/signoff-summary'
import type { TeacherSignoffCard } from '@/application/signoff'
import { signoffStateLabel } from '@/app/dashboard/_signoff/state-label'
import { cohortLabel } from '@/composition/cohorts'
import { describeCause, PURPOSE_LABEL } from '@/composition/signoff'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute } from '@/shared/time'

/**
 * 老師作業區「同意書」分頁（TE-04；原本 `/dashboard/teacher/signoff` 自己一頁，現在那個網址轉到這裡）。
 *
 * **此刻**指導的每一組、每個簽核包的目前那一版一張卡，換掉的老師這裡就看不到那一組（查詢只看有效的主指導）。
 * 表態留在版本頁 `/dashboard/teacher/signoff/{versionId}`（老師要先讀到全文，產品 07）：
 * 輪到你的那張是橘色「閱讀全文並回覆」，其他是「閱讀全文與進度」。學生全員同意後才輪到老師（伺服器也會擋）。
 */

/** 同意書的數量單位（D2 定案：一組可能有兩個簽核包，算「份」）。 */
export const SIGNOFF_UNIT = '份'

/** 排序：待我同意 → 等待學生 → 等別的指導老師 → 已完成與其他（同一類依組號）。 */
function rank(c: TeacherSignoffCard, mine: boolean): number {
  if (mine) return 0
  if (c.current.state === 'collecting') return 1
  if (c.current.state === 'teacher_pending') return 2
  return 3
}

/** 卡上的狀態字（原型「輪到你」「等待學生」「完成」「退回修正」；產品 07：「等待學生 2 位」）。 */
function cardStatus(c: TeacherSignoffCard): { text: string; tone: PillTone } {
  const p = c.current.progress
  switch (c.current.state) {
    case 'collecting':
      return { text: `等待學生 ${p.total - p.agreed} 位`, tone: 'default' }
    case 'teacher_pending':
      return c.mine.isSnapshotAdvisor ? { text: '輪到你', tone: 'brand' } : { text: '學生都已同意，等指導老師', tone: 'default' }
    case 'complete':
      return { text: '已完成', tone: 'success' }
    case 'revision':
      return { text: '已退回修正', tone: 'brand' }
    default:
      return { text: signoffStateLabel(c.current.state, { cause: c.current.cause }), tone: 'default' }
  }
}

/** 卡的第二行：誰還沒同意、版本、屆別。 */
function cardDetail(c: TeacherSignoffCard, mine: boolean): string {
  const v = c.current
  const p = v.progress
  const waiting = p.students.filter((s) => s.result === null).map((s) => s.displayName)
  const head = `第 ${v.versionNo} 版・${cohortLabel({ name: c.cohortName, code: c.cohortCode })}`
  switch (v.state) {
    case 'collecting':
      return `學生 ${p.agreed}／${p.total} 已同意${waiting.length ? `・還沒：${waiting.join('、')}` : ''}・${head}`
    case 'teacher_pending':
      return `學生 ${p.agreed}／${p.total} 已同意・${head}・${mine ? '等你' : '等指導老師'}`
    case 'complete':
      return `學生 ${p.total}／${p.total}・老師已同意・${head}`
    case 'revision':
      return `已退回，新版建立後全組重走一次・${head}`
    case 'superseded':
      return `已作廢（${describeCause(v.cause) ?? '—'}），等新版建立・${head}`
    default:
      return `${head}・${formatTaipeiMinute(v.createdAt)} 建立`
  }
}

export function SignoffTab({ cards }: { cards: readonly TeacherSignoffCard[] }) {
  const ready = new Set(teacherSignoffSummary(cards).ready)
  const rows = [...cards].sort((a, b) => rank(a, ready.has(a)) - rank(b, ready.has(b)) || a.groupCode.localeCompare(b.groupCode))
  const waiting = cards.filter((c) => c.current.state === 'collecting').length
  const complete = cards.filter((c) => c.current.state === 'complete').length

  return (
    <>
      {cards.length > 0 ? (
        <p className="tabular text-sm" data-testid="signoff-summary">
          <b className={ready.size ? 'text-primary' : 'text-foreground'}>
            待我同意 {ready.size} {SIGNOFF_UNIT}
          </b>
          <span className="text-muted-foreground">
            ・等待學生 {waiting} {SIGNOFF_UNIT}・已完成 {complete} {SIGNOFF_UNIT}
          </span>
        </p>
      ) : null}
      <Panel title="我的指導組別" icon={<IconSignature />} description={`${rows.length} ${SIGNOFF_UNIT}`}>
        {rows.length === 0 ? (
          <PanelEmpty icon={<IconSignature />} title="目前沒有待處理的同意書" hint="你指導的組別還沒有站內同意書。組員全部同意後才會輪到你。" />
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((c) => {
              const mine = ready.has(c)
              const status = cardStatus(c)
              const href = `/dashboard/teacher/signoff/${c.current.versionId}`
              return (
                <li
                  key={c.current.versionId}
                  data-testid="teacher-signoff-card"
                  className={cn('grid items-center gap-x-4 gap-y-3 px-5 py-4 md:grid-cols-[minmax(0,1fr)_auto]', mine && 'border-l-[3px] border-l-primary')}
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
                      {signoffStateLabel(c.current.state, { cause: c.current.cause })}・{cardDetail(c, mine)}
                    </p>
                  </div>
                  <div className="md:justify-self-end">
                    {mine ? (
                      <Link href={href} className={PRIMARY_BUTTON}>
                        閱讀全文並回覆
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
    </>
  )
}
