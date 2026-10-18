import Link from 'next/link'
import type { ReactNode } from 'react'
import { IconAlertTriangle, IconChecklist, IconPencilPlus, IconSignature, IconUserQuestion } from '@tabler/icons-react'
import { requireRole } from '@/app/_ui/guard'
import { HomeHero, loadStage } from '@/app/dashboard/_stage'
import { Donut, LegendRow, ListRow, Meter, Panel, PanelEmpty, Pill } from '@/app/dashboard/_home'
import { DashboardShell } from '@/app/_ui/site-shell'
import { SectionHead, TodoCard } from '@/app/_ui/dashboard/cards'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { adminHeroCta } from '@/app/dashboard/admin/home-cta'
import { adminHomePorts, adminTodoCards, heroLine, loadAdminHome, type TodoCardKind } from '@/app/dashboard/admin/home-data'
import { formatTaipeiDate, taipeiDateOf } from '@/shared/time'

export const metadata = { title: '系辦首頁｜資管系專題平台' }

const BASE = '/dashboard/admin'

const TODO_ICON: Record<TodoCardKind, ReactNode> = {
  accounts: <IconUserQuestion />,
  overdue: <IconAlertTriangle />,
  grading: <IconChecklist />,
  signoff: <IconSignature />,
}

/**
 * 管理員首頁（AD-02，設計方案 §3.1）：
 * 歡迎列＋現在階段 → 「待辦」四張卡 →（有才出現）成績更正待復核 → 作業完成率＋本屆分組 → 老師評分進度＋我發的公告。
 *
 * 每個數字都接到真的處理路徑；資料全部由 `loadAdminHome` 讀（可注入 port，AC-AD-04 計數）。
 * 「主機儲存」只在開發者後台看，這裡不讀。沒有資料時區塊照樣在，顯示 0 或一句空狀態。
 */
export default async function AdminHomePage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住，App Router 會把 layout 與 page 並行渲染，
  // layout 丟掉 children 或 redirect 都來不及——那一頁已經被做出來、跟著 payload 送走了。
  const actor = await requireRole(BASE, 'admin')
  const ctx = await loadStage(actor, 'staff')
  const home = await loadAdminHome(adminHomePorts(), actor, ctx)
  const { groups, intake, teachers, news, pendingReviews } = home

  const name = actor.kind === 'authenticated' && actor.displayName ? actor.displayName : '系辦'

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current={BASE}>
      <div className="flex flex-col gap-5">
        <HomeHero
          ctx={ctx}
          perspective="staff"
          name={name}
          line={heroLine(home, ctx.cohort !== null)}
          compact
          cta={adminHeroCta(ctx, home.summary?.pendingApplications ?? 0)}
          trail
        />

        {/* 一組待辦卡（Q88）：四條處理路徑，數字是 0 也在。 */}
        <section aria-label="待辦" className="flex flex-col gap-3">
          <SectionHead title="待辦" />
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {adminTodoCards(home).map((card) => (
              <TodoCard
                key={card.kind}
                tone={card.tone}
                icon={TODO_ICON[card.kind]}
                title={card.title}
                meta={card.meta}
                href={card.href}
                pill={card.pill}
                testId={`todo-${card.kind}`}
              />
            ))}
          </div>
        </section>

        {/* 成績更正待復核（N-61）：採計分數或方案變了，原更正暫不套用，要系辦去確認；沒有就不出現。 */}
        {pendingReviews.length > 0 ? (
          <div
            role="status"
            data-testid="pending-review-notice"
            className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-muted/50 px-5 py-3 text-sm"
          >
            <IconAlertTriangle className="size-5 shrink-0 text-destructive" aria-hidden />
            <span className="min-w-0 flex-1">
              <b className="font-semibold text-foreground">成績更正需要重新確認 {pendingReviews.length} 筆</b>
              <span className="text-muted-foreground">
                （{pendingReviews.map((p) => p.groupCode).join('、')}）：這些組的評分後來有變動（老師重評、改派或換評分規則），原本的人工更正暫時不套用，要你確認保留先前更正的分數，或重新更正。
              </span>
            </span>
            <Link
              href={pendingReviews.length === 1 ? `${BASE}/grading/${pendingReviews[0]!.groupId}` : `${BASE}/grading`}
              className="shrink-0 font-semibold text-primary-on-subtle hover:underline"
            >
              去確認
            </Link>
          </div>
        ) : null}

        <div className="grid grid-cols-[minmax(0,1fr)] gap-5 md:grid-cols-3">
          <div className="min-w-0 md:col-span-2">
            {/* 「作業完成率」只有管理員看得到：pages.spec 的直接打 HTTP 回歸測試用它當指紋，沒有屆別時也要在。 */}
            <Panel title="作業完成率" description="點一列看未繳名單" action={{ href: `${BASE}/affairs`, label: '公告與作業' }} className="h-full">
              {intake.length === 0 ? (
                <PanelEmpty>本屆還沒有發布中的作業。到「公告與作業」新增作業後，這裡會顯示每一份的完成率。</PanelEmpty>
              ) : (
                <ul className="flex flex-col px-2 pb-2">
                  {intake.map((i) => {
                    const c = i.completion
                    const missing = c.required - c.done
                    return (
                      <li key={i.id}>
                        <Link href={`${BASE}/affairs/${i.id}`} className="group flex flex-col gap-1.5 rounded-xl px-3 py-2.5 transition-colors hover:bg-accent/60">
                          <span className="flex items-center justify-between gap-3 text-sm">
                            <span className="truncate font-semibold text-foreground">{i.title}</span>
                            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                              {c.done}／{c.required} {i.unit}
                              {c.overdue ? <span className="ml-1 font-semibold text-destructive">逾期 {c.overdue}</span> : null}
                            </span>
                          </span>
                          <span className="flex items-center gap-3">
                            <SegmentBar done={c.done} overdue={c.overdue} total={c.required} />
                            <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums group-hover:text-foreground">
                              {c.required === 0 ? '—' : missing ? `未繳 ${missing}` : '全數'}
                            </span>
                          </span>
                        </Link>
                      </li>
                    )
                  })}
                </ul>
              )}
            </Panel>
          </div>

          <div className="min-w-0">
            <Panel
              title="本屆分組"
              description={`${groups.total} 組・${groups.students} 人`}
              action={{ href: `${BASE}/groups`, label: '總覽' }}
              className="h-full"
            >
              <div className="flex items-center gap-5 px-5 pt-1 pb-5">
                <Donut
                  label={`一般專題 ${groups.total - groups.industry} 組、產學合作 ${groups.industry} 組`}
                  segments={[
                    { value: groups.total - groups.industry, color: 'var(--ink)' },
                    { value: groups.industry, color: 'var(--primary)' },
                  ]}
                  center={
                    <span>
                      <span className="block text-[22px] leading-none font-extrabold tabular-nums">{groups.total}</span>
                      <span className="text-[10px] text-muted-foreground">組</span>
                    </span>
                  }
                />
                <ul className="flex flex-1 flex-col gap-2 text-sm">
                  <LegendRow color="var(--ink)" label="一般專題" value={groups.total - groups.industry} />
                  <LegendRow color="var(--primary)" label="產學合作" value={groups.industry} />
                  <li className="flex items-center justify-between border-t border-border/70 pt-2">
                    <Link href={`${BASE}/groups`} className="hover:underline">
                      產學未指派
                    </Link>
                    <b className="tabular-nums">{groups.noAdvisorIndustry}</b>
                  </li>
                  <li className="flex items-center justify-between">
                    <Link href={`${BASE}/groups`} className="hover:underline">
                      未分組學生
                    </Link>
                    <b className="tabular-nums">{groups.ungrouped}</b>
                  </li>
                  <li className="flex items-center justify-between">
                    <Link href={`${BASE}/groups`} className="hover:underline">
                      進行中提案
                    </Link>
                    <b className="tabular-nums">{groups.openProposals}</b>
                  </li>
                </ul>
              </div>
            </Panel>
          </div>

          <div className="min-w-0 md:col-span-2">
            {/* 每位老師一張小卡（全部階段、排除解散組，跟成績頁同一個 teacherProgress，AC-AD-03）。 */}
            <Panel title="老師評分進度" description={`還差 ${home.remaining} 份`} action={{ href: `${BASE}/grading`, label: '成績' }} className="h-full">
              {teachers.length === 0 ? (
                <PanelEmpty>還沒有指派評分。到「成績」頁設定評分方案與指派老師後，這裡會列出每位老師的進度。</PanelEmpty>
              ) : (
                <ul className="grid gap-3 px-5 pb-5 sm:grid-cols-2 lg:grid-cols-3" aria-label="每位老師的評分進度">
                  {teachers.map((t) => {
                    const done = t.counted === t.assigned
                    return (
                      <li key={t.userId} className="min-w-0">
                        <Link
                          href={`${BASE}/grading`}
                          data-testid="teacher-progress-card"
                          className="flex flex-col gap-2 rounded-xl border border-border px-4 py-3 transition-colors hover:bg-accent/60"
                        >
                          <span className="flex items-center justify-between gap-2 text-sm">
                            <span className="truncate font-semibold text-foreground">
                              {t.name}
                              {t.inactive ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">（已停用）</span> : null}
                            </span>
                            {done ? <Pill tone="success">完成</Pill> : null}
                          </span>
                          <span className="text-xs text-muted-foreground tabular-nums">
                            已評 {t.counted}／{t.assigned}
                          </span>
                          <Meter value={t.counted} total={t.assigned} done={done} />
                        </Link>
                      </li>
                    )
                  })}
                </ul>
              )}
            </Panel>
          </div>

          <div className="min-w-0">
            <Panel
              title="我發的公告"
              description={`${home.newsCount} 則`}
              action={
                <Link
                  href={`${BASE}/editor/new`}
                  className="inline-flex shrink-0 items-center gap-1 text-[13px] font-semibold text-primary-on-subtle hover:underline"
                >
                  <IconPencilPlus className="size-4" aria-hidden />
                  發布公告
                </Link>
              }
              className="h-full"
            >
              {news.length === 0 ? (
                <PanelEmpty>本屆還沒有公告。按「發布公告」寫第一則。</PanelEmpty>
              ) : (
                <ul>
                  {news.map((n) => (
                    <ListRow
                      key={n.id}
                      href={n.status === 'published' ? `/news/${n.id}` : `${BASE}/editor/${n.id}`}
                      code={formatTaipeiDate(taipeiDateOf(n.updatedAt)).slice(5)}
                      title={n.title}
                      trailing={n.status === 'draft' ? <Pill tone="brand">草稿</Pill> : n.status === 'archived' ? <Pill>已下架</Pill> : null}
                    />
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </div>
      </div>
    </DashboardShell>
  )
}

/** 完成率條（原型 SegmentBar）：已繳橘、逾期紅、其餘底色；寬度用 SVG 百分比屬性（CSP）。 */
function SegmentBar({ done, overdue, total }: { done: number; overdue: number; total: number }) {
  const pct = (n: number) => (total === 0 ? 0 : (n / total) * 100)
  return (
    <svg className="block h-2 min-w-0 flex-1" role="img" aria-label={`已繳 ${done}、逾期 ${overdue}、共 ${total}`}>
      <rect width="100%" height="100%" rx="4" fill="var(--muted)" />
      {done > 0 ? <rect width={`${pct(done)}%`} height="100%" rx="4" fill="var(--primary)" /> : null}
      {overdue > 0 ? <rect x={`${pct(done)}%`} width={`${pct(overdue)}%`} height="100%" fill="var(--destructive)" /> : null}
    </svg>
  )
}
