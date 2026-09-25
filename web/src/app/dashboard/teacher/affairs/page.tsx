import Link from 'next/link'
import { IconClipboardText, IconUser } from '@tabler/icons-react'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { TEACHER_NAV } from '@/app/dashboard/_nav'
import { OUTLINE_BUTTON_SM, PageTitle, Panel, PanelEmpty, type PillTone } from '@/app/dashboard/teacher/_ui/dash'
import { MatrixTable, type MatrixCell, type MatrixItem, type MatrixRow } from '@/app/dashboard/teacher/affairs/matrix-table'
import type { AdvisorMatrixCell, AdvisorMatrixItem, StatusTone } from '@/application/submissions'
import { getBusinessClock } from '@/composition/cohorts'
import { GROUP_TYPE_LABEL } from '@/composition/groups'
import { categoryOf, getAdvisorSubmissionQuery, receiverStatus } from '@/composition/submissions'
import { formatTaipeiMinute } from '@/shared/time'

export const metadata = { title: '各組繳交狀態｜資管系專題平台' }

/** 狀態字的顏色（原型 `StateBadge`：已繳綠、逾期紅、其他灰；草稿老師看不到，不會出現）。 */
const TONE: Record<StatusTone, PillTone> = { success: 'success', brand: 'brand', muted: 'default', info: 'info', danger: 'danger' }

/**
 * 老師「各組繳交狀態」（票 22；票 37 照原型 `/dashboard/teacher/affairs` 的「指導組別 × 收件項目」矩陣）。
 *
 * 只列老師**此刻**指導的組別（換掉的組下一次打開就不見了），欄是那些組所在屆別、發布中、整組一份的收件；
 * 每格是那一組的狀態（跟學生作業區、系辦名單頁同一個 `receiverStatus`），點進去看版本與內容。
 * 老師看不到共用草稿，所以沒交的格子一律是「未繳」，不會出現「草稿已存」。
 * 下面另列系辦開了主指導閱覽的個人收件（沒開的個人收件老師看不到，產品模組 05 §4；原型沒有這一塊）。
 */
export default async function TeacherAffairsPage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole('/dashboard/teacher/affairs', 'teacher')
  const [matrix, businessNow] = await Promise.all([getAdvisorSubmissionQuery().matrix(actor), getBusinessClock().now()])
  const groups = matrix?.groups ?? []
  const items = matrix?.items ?? []
  const individual = matrix?.individualItems ?? []
  const cellOf = new Map((matrix?.cells ?? []).map((c) => [`${c.groupId}:${c.itemId}`, c]))

  const matrixItems: MatrixItem[] = items.map((item) => ({
    itemId: item.itemId,
    title: item.title,
    due: item.dueAt ? formatTaipeiMinute(item.dueAt).slice(5) : null,
  }))
  const rows: MatrixRow[] = groups.map((group) => ({
    groupId: group.groupId,
    code: group.code,
    meta: `${group.cohortCode}・${GROUP_TYPE_LABEL[group.groupType]}`,
    members: group.memberNames.join('、'),
    cells: Object.fromEntries(
      items.map((item) => [
        item.itemId,
        cellView(item, group.groupId, item.cohortId === group.cohortId ? cellOf.get(`${group.groupId}:${item.itemId}`) : undefined, businessNow),
      ]),
    ),
  }))

  return (
    <DashboardShell roleLabel="老師" items={TEACHER_NAV} current="/dashboard/teacher/affairs">
      <div className="flex flex-col gap-5">
        <PageTitle
          title="各組繳交狀態"
          description={`我的 ${groups.length} 個指導組別 × ${items.length} 個整組收件。點狀態看每一次正式送出的版本與內容。`}
        />

        <Panel title="繳交矩陣" icon={<IconClipboardText />} description="點狀態看版本與內容" bodyClassName={groups.length > 0 && items.length > 0 ? 'p-4' : undefined}>
          {groups.length === 0 ? (
            <PanelEmpty
              icon={<IconClipboardText />}
              title="你目前沒有指導的組別"
              hint="系辦指派或你在「分組總覽」認領產學組之後，那些組的繳交狀態會出現在這裡。換老師後，原本的組就不會再出現。"
              action={{ href: '/dashboard/teacher/groups', label: '到分組總覽' }}
            />
          ) : items.length === 0 ? (
            <PanelEmpty icon={<IconClipboardText />} title="還沒有整組一份的收件" hint="系辦發布整組一份的收件之後，會在這裡列出你指導的每一組交了沒。" />
          ) : (
            <MatrixTable items={matrixItems} rows={rows} />
          )}
        </Panel>

        {individual.length > 0 ? (
          <Panel title="開放主指導閱覽的個人收件" icon={<IconUser />} description="只看得到你指導的學生正式送出的回答，草稿不給">
            <ul className="divide-y divide-border" data-testid="individual-items">
              {individual.map((item) => (
                <li key={item.itemId} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 transition-colors hover:bg-accent/40">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-foreground">{item.title}</span>
                    <span className="tabular block text-xs text-muted-foreground">
                      {item.dueAt ? `${formatTaipeiMinute(item.dueAt)} 截止` : '無截止'}・欄位第 {item.effectiveFromVersionNo} 版起開放
                    </span>
                  </span>
                  <span className="tabular text-sm font-semibold">
                    已繳 {item.submitted}／{item.required} 位
                  </span>
                  <Link href={`/dashboard/teacher/affairs/${item.itemId}`} className={OUTLINE_BUTTON_SM}>
                    查看
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}
      </div>
    </DashboardShell>
  )
}

/** 一格的狀態字（跟學生作業區、系辦名單頁同一個 `receiverStatus`；草稿一律當沒有）。 */
function cellView(item: AdvisorMatrixItem, groupId: string, cell: AdvisorMatrixCell | undefined, businessNow: Date): MatrixCell {
  if (!cell) return null
  const category = categoryOf(cell)
  const status = receiverStatus(item, { exempt: cell.exempt, hasDraft: false, latestVersionNo: cell.latestVersionNo }, businessNow)
  const headline = category === 'removed' ? '已移出名單' : status.headline
  const tone: PillTone = category === 'current' ? TONE[status.tone] : 'default'
  let detail = ''
  if (cell.latestVersionNo !== null && cell.latestReceivedAt) {
    detail = `${cell.latestSubmittedByName ?? ''}・${formatTaipeiMinute(cell.latestReceivedAt)}`
  } else if (category === 'current' && status.headline === '尚未開放') {
    detail = status.detail
  } else if (category === 'current' && !status.overdue) {
    detail = '還沒正式送出'
  }
  return { headline, tone, detail, href: `/dashboard/teacher/affairs/${item.itemId}?group=${groupId}` }
}
