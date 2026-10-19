import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react'
import type { TeacherQueueEntry } from '@/application/grading'
import type { NeighbourLink } from '@/app/dashboard/teacher/grading/[groupId]/bench-types'
import { OUTLINE_BUTTON } from '@/app/dashboard/teacher/_ui/dash'
import { myStatusOf } from '@/app/dashboard/teacher/grading/rules'
import { cn } from '@/shared/cn'

/**
 * 三欄批改頁的左欄上半（C1-12，設計方案① §7.3、AC-28）：這個評分項目分給我的組（目前組高亮）＋「上一組／下一組」。
 * 伺服器元件、沒有瀏覽器端 JS（`[groupId]` 路由的 JS 預算很緊）。
 *
 * 換組一律用整頁導向（一般 `<a>`，不是 client 端路由）：評分卡還有沒存的輸入時，瀏覽器的「離開此頁？」提示
 * （評分卡掛的 beforeunload）才會跳出來；換過去評分卡整個重掛，右欄就是那一組自己的內容。
 */
export function GroupRail({
  entries,
  currentGroupId,
  hrefOf,
  prev,
  next,
}: {
  /** 這個評分項目分給我的全部組（照老師清單順序）。 */
  entries: readonly TeacherQueueEntry[]
  currentGroupId: string
  hrefOf: (groupId: string) => string
  prev: NeighbourLink
  next: NeighbourLink
}) {
  return (
    <section aria-label="組別" className="dash-card flex min-w-0 flex-col overflow-hidden">
      <nav aria-label="切換組別" className="grid grid-cols-2 gap-2 p-3">
        <NeighbourButton side="prev" link={prev} />
        <NeighbourButton side="next" link={next} />
      </nav>
      <ul aria-label="本評分項目的組別" className="flex max-h-72 flex-col gap-0.5 overflow-y-auto border-t border-border p-2 xl:max-h-[40vh]">
        {entries.map((e) => {
          const on = e.groupId === currentGroupId
          const status = myStatusOf(e)
          return (
            <li key={e.assignmentId}>
              <a
                href={hrefOf(e.groupId)}
                aria-current={on ? 'page' : undefined}
                data-testid="rail-group"
                className={cn(
                  'flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring/40',
                  on ? 'bg-ink font-bold text-ink-foreground' : 'text-foreground hover:bg-accent',
                )}
              >
                <span className="tabular min-w-0 truncate">
                  {e.groupCode}
                  {e.leaderName ? <span className={on ? 'font-normal opacity-80' : 'text-muted-foreground'}>{`・${e.leaderName}`}</span> : null}
                </span>
                <span className={cn('shrink-0 text-xs', on ? 'opacity-80' : 'text-muted-foreground')}>{status.text}</span>
              </a>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** 上一組／下一組；第一組／最後一組那一邊停用。 */
function NeighbourButton({ side, link }: { side: 'prev' | 'next'; link: NeighbourLink }) {
  const label = side === 'prev' ? '上一組' : '下一組'
  const content =
    side === 'prev' ? (
      <>
        <IconChevronLeft aria-hidden />
        {label}
      </>
    ) : (
      <>
        {label}
        <IconChevronRight aria-hidden />
      </>
    )
  if (!link) {
    return (
      <a role="link" aria-disabled="true" className={cn(OUTLINE_BUTTON, 'pointer-events-none h-9 justify-center px-2 opacity-50')}>
        {content}
      </a>
    )
  }
  return (
    <a href={link.href} title={`${label}：${link.groupCode}`} className={cn(OUTLINE_BUTTON, 'h-9 justify-center px-2')}>
      {content}
      <span className="sr-only">：{link.groupCode}</span>
    </a>
  )
}
