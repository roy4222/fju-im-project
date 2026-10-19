import Link from 'next/link'
import { IconChevronRight, IconFileText, IconPin, IconSignature } from '@tabler/icons-react'
import { requireRole } from '@/app/_ui/guard'
import { HomeHero, loadStage, type HeroNext } from '@/app/dashboard/_stage'
import { Panel, PanelEmpty, Pill } from '@/app/dashboard/_home'
import { DashboardShell } from '@/app/_ui/site-shell'
import { SectionHead, TodoCard, type Tone } from '@/app/_ui/dashboard/cards'
import { STUDENT_NAV } from '@/app/dashboard/_nav'
import { dueText } from '@/app/dashboard/student/_todo/due-text'
import { homeTodos, nextDue, studentItems, studentOpenCount, studentTodos, type StudentTodo } from '@/app/dashboard/student/_todo/todos'
import { getPublicItemQuery } from '@/composition/items'
import { taipeiDateOf } from '@/shared/time'

export const metadata = { title: '學生首頁｜資管系專題平台' }

const BASE = '/dashboard/student'

/** 待辦卡顏色（學生規格 §3.2）：同意書待表態是紫色，其他照狀態；顏色本身由 `TodoCard` 的 `data-tone` 處理。 */
function toneOf(todo: StudentTodo): Tone {
  if (todo.kind === 'consent' && todo.status === 'open') return 'violet'
  switch (todo.status) {
    case 'overdue':
      return 'overdue'
    case 'soon':
      return 'soon'
    case 'open':
      return 'open'
    case 'notOpen':
      return 'neutral'
    case 'done':
    case 'exempt':
      return 'done'
  }
}

/**
 * 學生首頁（ST-2，學生規格 §3.2）：「現在」橫幅 → 待辦卡（最多 5 張）→ 公告 5 則。
 *
 * 待辦與「下一件要交的」都從 ST-1 的 `studentTodos` 來（跟側欄徽章、交作業列表同一份清單），不在這頁另算。
 * 行事曆與「接下來」搬到前台 `/timeline`，橫幅的「看完整時程」連過去。
 */
export default async function StudentHomePage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住，App Router 會把 layout 與 page 並行渲染，
  // layout 丟掉 children 或 redirect 都來不及——那一頁已經被做出來、跟著 payload 送走了。
  const actor = await requireRole(BASE, 'student')
  const userId = actor.kind === 'authenticated' ? actor.userId : ''
  // `studentItems` 有 React cache：`studentTodos` 已經讀過，這裡只是拿同一個業務鐘的「現在」算截止字。
  const [ctx, todos, [, now], news] = await Promise.all([
    loadStage(actor, 'student'),
    studentTodos(userId),
    studentItems(userId),
    getPublicItemQuery().list(actor, 'news', { limit: 5 }),
  ])

  const upNext = nextDue(todos)
  const next: HeroNext | undefined = upNext
    ? { title: upNext.title, due: dueText(upNext, now), href: upNext.href, label: '去交' }
    : undefined
  const cards = homeTodos(todos)
  const name = actor.kind === 'authenticated' && actor.displayName ? actor.displayName : '同學'

  return (
    <DashboardShell roleLabel="學生" items={STUDENT_NAV} current={BASE}>
      <div className="flex flex-col gap-6">
        <HomeHero
          ctx={ctx}
          perspective="student"
          name={name}
          line={upNext ? `下一件要交的是「${upNext.title}」` : '目前沒有要交的'}
          timelineHref="/timeline"
          next={next ?? <p className="text-[15px] font-bold">目前沒有要交的</p>}
          trail
        />

        <section aria-label="待辦" className="flex flex-col gap-3">
          <SectionHead title="待辦" count={studentOpenCount(todos)} action={{ label: '全部作業', href: `${BASE}/affairs` }} />
          {cards.length === 0 ? (
            <p className="text-sm text-muted-foreground">目前沒有要交的作業</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {cards.map((todo) => (
                <TodoCard
                  key={`${todo.kind}-${todo.id}`}
                  tone={toneOf(todo)}
                  icon={todo.kind === 'consent' ? <IconSignature /> : <IconFileText />}
                  title={todo.title}
                  meta={
                    // 整組一份的作業加小字「整組」（Q128）。
                    todo.unit === 'group' ? (
                      <>
                        <span className="font-semibold">整組</span>・{dueText(todo, now)}
                      </>
                    ) : (
                      dueText(todo, now)
                    )
                  }
                  pill={{ label: todo.label }}
                  href={todo.href}
                  testId={`todo-${todo.id}`}
                />
              ))}
            </div>
          )}
        </section>

        {/* 「公告」區的結構（region 名「公告」、Panel 標題、`/news/` 連結列）是 AC-V10 `item-pin.spec.ts` 的定位，不要改。 */}
        <div role="region" aria-label="公告">
          <Panel title="公告" action={{ href: '/news', label: '全部公告' }}>
            {news.length === 0 ? (
              <PanelEmpty>目前沒有公告。</PanelEmpty>
            ) : (
              <ul className="px-2 pb-2">
                {news.map((n) => {
                  const date = taipeiDateOf(n.publishedAt)
                  return (
                    <li key={n.id}>
                      <Link href={`/news/${n.id}`} className="flex items-center gap-4 rounded-xl px-3 py-2.5 transition-colors hover:bg-accent/60">
                        <span className="flex w-11 shrink-0 flex-col items-center rounded-xl bg-muted py-1.5 leading-none tabular-nums">
                          <span className="text-[10px] font-semibold text-muted-foreground">{Number(date.slice(5, 7))} 月</span>
                          <span className="mt-0.5 text-[17px] font-extrabold text-foreground">{Number(date.slice(8, 10))}</span>
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold text-foreground">{n.title}</span>
                          <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                            {n.pinnedAt ? (
                              <Pill tone="brand">
                                <span data-testid="pinned-tag" className="inline-flex items-center">
                                  <IconPin className="mr-0.5 size-3" aria-hidden />
                                  置頂
                                </span>
                              </Pill>
                            ) : null}
                            <span className="truncate">{n.category ?? '公告'}</span>
                          </span>
                        </span>
                        <IconChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      </Link>
                    </li>
                  )
                })}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </DashboardShell>
  )
}
