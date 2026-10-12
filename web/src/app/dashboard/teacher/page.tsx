import Link from 'next/link'
import { IconChecklist, IconChevronRight } from '@tabler/icons-react'
import { requireRole } from '@/app/_ui/guard'
import { HomeHero, loadStage } from '@/app/dashboard/_stage'
import { Donut, LegendRow, ListRow, Panel, PanelEmpty, Pill } from '@/app/dashboard/_home'
import { DashboardShell } from '@/app/_ui/site-shell'
import { TEACHER_NAV } from '@/app/dashboard/_nav'
import { teacherSignoffSummary } from '@/app/dashboard/teacher/signoff-summary'
import type { ResolvedActor } from '@/application/accounts'
import type { AudienceKind } from '@/application/items'
import { cohortLabel, getTimelineQuery } from '@/composition/cohorts'
import { getGradingQuery } from '@/composition/grading'
import { getGroupQuery, getOpportunityQuery } from '@/composition/groups'
import { AUDIENCE_LABEL, getPublicItemQuery } from '@/composition/items'
import { getSignoffQuery, PURPOSE_LABEL } from '@/composition/signoff'
import { cn } from '@/shared/cn'
import { taipeiDateOf, taipeiTimeOf } from '@/shared/time'

export const metadata = { title: '老師首頁｜資管系專題平台' }

const BASE = '/dashboard/teacher'

/**
 * 「給老師的公告」列哪幾種對象（Q13、Q14，2026-09-26 定案）：全部老師、所有已登入、指定組別（前台查詢只回
 * 自己指導的組）。「本屆學生」與「公開」不列在這裡——指導老師在 `/news` 仍看得到，只是不佔首頁。
 */
const TEACHER_NEWS: readonly AudienceKind[] = ['teachers', 'signed_in', 'groups']

/**
 * 「本屆活動」的來源：老師目前指導的屆別（Q13「自己指導那一屆」，不一定是工作屆別）＋系辦設定的工作屆別。
 * 「本屆學生」的活動只算指導的屆別；其他對象（只給老師、所有登入者、公開）老師本來就在對象內。
 */
async function teacherActivities(actor: ResolvedActor, workingCohortId: string | undefined) {
  const advisedCohorts = await getPublicItemQuery().advisedCohortIds(actor)
  const cohortIds = [...new Set([...(workingCohortId ? [workingCohortId] : []), ...advisedCohorts])]
  const lists = await Promise.all(cohortIds.map((id) => getTimelineQuery().activities(id)))
  return { advisedCohorts, activities: lists.flat() }
}

/**
 * 老師首頁（2026-09-25 外觀對齊原型 `home-teacher`，區塊與順序照原型）：
 * 歡迎色塊（現在階段、本屆進度、繼續評分、四格摘要）＋評分進度 → 評分工作台＋給老師的公告與本屆活動
 * ＋可認領產學組 → 同意書＋指導組別＋合作案。
 * 2026-09-26 定案（Q7②、Q13、Q14；取代 09-10「老師不要行事曆／公告／時間軸」）：首頁加「給老師的公告」
 * （全部老師、所有已登入、我指導的組三種，新到舊 5 則）與「本屆活動」（自己指導的屆別＋工作屆別；
 * 「本屆學生」的活動只列自己指導的屆別）。
 *
 * 讀取全部是既有、以老師本人為範圍的查詢：評分只回本人的有效指派、簽核只回本人此刻指導的組、
 * 合作案只列本人建立的；組別清單是「所有老師都可查看」的那一份（跟「分組」頁同一個查詢）；
 * 公告是前台同一個依看的人過濾的查詢；活動是本屆時間軸，在這裡依身分過濾。
 */
export default async function TeacherHomePage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住，App Router 會把 layout 與 page 並行渲染，
  // layout 丟掉 children 或 redirect 都來不及——那一頁已經被做出來、跟著 payload 送走了。
  const actor = await requireRole(BASE, 'teacher')
  const me = actor.kind === 'authenticated' ? actor.userId : ''
  const ctx = await loadStage(actor, 'staff')

  const [queue, signCards, groups, cases, advised, news, timeline] = await Promise.all([
    getGradingQuery().teacherQueue(actor),
    getSignoffQuery().teacherView(actor),
    ctx.cohort ? getGroupQuery().cohortGroups(ctx.cohort.id) : Promise.resolve([]),
    getOpportunityQuery().manageList(actor),
    getGroupQuery().advisedGroupCount(me),
    // 前台查詢已依看的人過濾（指定組別只回自己指導的組）；SQL 先篩這三種對象再取 5 則，不會被公開公告擠掉。
    getPublicItemQuery().list(actor, 'news', { audiences: TEACHER_NEWS, limit: 5 }),
    teacherActivities(actor, ctx.cohort?.id),
  ])

  const counts = {
    empty: queue.filter((e) => e.state === 'empty').length,
    draft: queue.filter((e) => e.state === 'draft').length,
    counted: queue.filter((e) => e.state === 'counted').length,
  }
  const remaining = counts.empty + counts.draft
  // 待我同意／等待學生：清單一包一列，數字依組別去重（一組可能有兩個簽核包；見 signoff-summary.ts）。
  const { ready, waiting, readyGroups, waitingGroups } = teacherSignoffSummary(signCards)
  const claimable = groups.filter((g) => g.groupType === 'industry' && g.advisor === null)
  const myGroups = groups.filter((g) => g.advisor?.teacherUserId === me)
  const myCases = cases.filter((c) => c.ownerUserId === me && c.status !== 'withdrawn')
  // 本屆活動：今天以後、沒取消的，早的在前。
  const { advisedCohorts } = timeline
  const cohortActivities = timeline.activities
    .filter((a) => a.status === 'scheduled' && taipeiDateOf(a.startsAt) >= ctx.today)
    .filter((a) => a.audienceKind !== 'cohort_students' || advisedCohorts.includes(a.cohortId))
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    .slice(0, 5)

  // 原型「歡迎回來，陳建宏 老師」；姓名本身已經以「老師」結尾就不再加。
  const own = actor.kind === 'authenticated' ? actor.displayName : undefined
  const name = own ? (own.endsWith('老師') ? own : `${own} 老師`) : '老師'
  const line = remaining ? `評分還有 ${remaining} 份沒正式送出：未開始 ${counts.empty}、草稿 ${counts.draft}。` : queue.length ? '評分都正式送出了。' : ''

  return (
    <DashboardShell roleLabel="老師" items={TEACHER_NAV} current={BASE}>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <HomeHero
          ctx={ctx}
          perspective="staff"
          name={name}
          line={line}
          showProgress
          icon={<IconChecklist strokeWidth={1.4} />}
          cta={remaining ? { href: `${BASE}/grading`, label: `繼續評分（${remaining} 份）` } : undefined}
          chips={[
            { label: '未開始', value: `${counts.empty} 份`, href: `${BASE}/grading` },
            { label: '草稿', value: `${counts.draft} 份`, href: `${BASE}/grading` },
            { label: '已送出', value: `${counts.counted} 份`, href: `${BASE}/grading` },
            { label: '待我同意', value: `${readyGroups} 組`, href: `${BASE}/signoff`, hot: readyGroups > 0 },
          ]}
        />

        <div className="min-w-0">
          <Panel title="評分進度" description="被指派的評分" className="h-full">
            <div className="flex items-center gap-5 px-5 pt-1 pb-4">
              <Donut
                label={`已送出 ${counts.counted}、草稿 ${counts.draft}、未開始 ${counts.empty}`}
                segments={[
                  { value: counts.counted, color: 'var(--success)' },
                  { value: counts.draft, color: 'var(--primary)' },
                  { value: counts.empty, color: 'var(--border)' },
                ]}
                center={
                  <span>
                    <span className="block text-[22px] leading-none font-extrabold tabular-nums">
                      {counts.counted}/{queue.length}
                    </span>
                    <span className="text-[10px] text-muted-foreground">已送出</span>
                  </span>
                }
              />
              <ul className="flex flex-1 flex-col gap-2 text-sm">
                <LegendRow color="var(--success)" label="已送出" value={counts.counted} />
                <LegendRow color="var(--primary)" label="草稿" value={counts.draft} />
                <LegendRow color="var(--border)" label="未開始" value={counts.empty} />
              </ul>
            </div>
            <p className="border-t border-border/70 px-5 py-3 text-xs text-muted-foreground">正式送出後鎖定；要改請系辦退回。</p>
          </Panel>
        </div>

        {/* 1280 寬（xl）只排兩欄：三欄時卡片標題被說明擠成「同…」（N-35）；更寬（2xl）才三欄。 */}
        <div className="grid grid-flow-dense grid-cols-[minmax(0,1fr)] gap-5 md:grid-cols-2 xl:col-span-2 2xl:grid-cols-3">
          <div className="min-w-0 md:col-span-2">
            <Panel
              title="我的評分"
              description={remaining ? `還有 ${remaining} 份` : `${queue.length} 份`}
              action={{ href: `${BASE}/grading`, label: '開啟' }}
              className="h-full"
            >
              {queue.length === 0 ? (
                <PanelEmpty>還沒有被指派評分。系辦指派之後，要評的組別會出現在這裡。</PanelEmpty>
              ) : (
                <ul>
                  {queue.slice(0, 6).map((e) => (
                    <ListRow
                      key={e.assignmentId}
                      href={`${BASE}/grading/${e.groupId}`}
                      code={e.groupCode}
                      title={e.stageName}
                      sub={`${cohortLabel({ name: e.cohortName, code: e.cohortCode })}・已填 ${e.filled}／${e.total} 項`}
                      trailing={
                        <>
                          {e.state === 'empty' ? <Pill>未開始</Pill> : e.state === 'draft' ? <Pill tone="brand">草稿</Pill> : <Pill tone="success">已送出</Pill>}
                          <span
                            className={cn(
                              'rounded-lg px-3 py-1 text-[13px] font-semibold',
                              e.state === 'counted' ? 'text-foreground' : 'bg-primary text-primary-foreground',
                            )}
                          >
                            {e.state === 'empty' ? '開始' : e.state === 'draft' ? '繼續' : '查看'}
                          </span>
                        </>
                      }
                    />
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          {/* 公告區占滿一列：左「給老師的公告」、右「本屆活動」（窄螢幕上下排）。 */}
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 md:col-span-2 md:grid-cols-2 2xl:col-span-3">
            <Panel title="給老師的公告" description="全部老師、所有已登入、我指導的組" action={{ href: '/news', label: '看全部公告' }} testId="home-teacher-news" className="h-full">
              {news.length === 0 ? (
                <PanelEmpty>目前沒有給老師的公告。給本屆學生的公告在「看全部公告」裡。</PanelEmpty>
              ) : (
                <ul className="pb-2">
                  {news.map((n) => (
                    <li key={n.id}>
                      <Link
                        href={`/news/${n.id}`}
                        className="flex min-h-11 items-center gap-3 border-t border-border/70 px-5 py-2.5 transition-colors hover:bg-accent/40"
                      >
                        <span className="w-12 shrink-0 text-xs font-semibold text-muted-foreground tabular-nums">
                          {taipeiDateOf(n.publishedAt).slice(5).replace('-', '/')}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold break-words text-foreground">{n.title}</span>
                          <span className="block text-xs text-muted-foreground">{AUDIENCE_LABEL[n.audienceKind]}</span>
                        </span>
                        <IconChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel
              title="本屆活動"
              description={advisedCohorts.length > 0 ? '我指導的屆別' : ctx.cohort?.name}
              testId="home-cohort-activities"
              className="h-full"
            >
              {cohortActivities.length === 0 ? (
                <PanelEmpty>
                  {advisedCohorts.length > 0
                    ? '你指導的屆別接下來沒有排定的活動。'
                    : ctx.cohort
                      ? '接下來沒有給老師的活動。指導某一屆的組別後，也會列出給那屆學生的活動。'
                      : '還沒有指導的組別，系辦也還沒設定後台預設查看的屆別。'}
                </PanelEmpty>
              ) : (
                <ul className="pb-2">
                  {cohortActivities.map((a) => (
                    <ListRow
                      key={a.id}
                      code={taipeiDateOf(a.startsAt).slice(5).replace('-', '/')}
                      title={a.title}
                      sub={a.allDay ? '全天' : taipeiTimeOf(a.startsAt)}
                    />
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <div className="min-w-0">
            {/* 「待指導的產學組」只有老師看得到：pages.spec 的直接打 HTTP 回歸測試用它當指紋。 */}
            <Panel
              title="待指導的產學組"
              description={`全體 ${claimable.length} 組・第一位確認的老師就是指導老師`}
              action={{ href: `${BASE}/groups`, label: '全部' }}
              tint="mint"
              className="h-full"
            >
              {claimable.length === 0 ? (
                <PanelEmpty>目前沒有等待指導老師的產學組。</PanelEmpty>
              ) : (
                <ul className="pb-2">
                  {claimable.slice(0, 5).map((g) => (
                    <ListRow
                      key={g.id}
                      code={g.code}
                      title={g.opportunity?.name ?? `${g.members.length} 人`}
                      trailing={
                        <Link href={`${BASE}/groups`} className="rounded-lg border border-border bg-card px-3 py-1 text-[13px] font-semibold hover:bg-accent">
                          擔任指導老師
                        </Link>
                      }
                    />
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <div className="min-w-0">
            <Panel
              title="同意書"
              description={`待我同意 ${readyGroups} 組・等待學生 ${waitingGroups} 組`}
              action={{ href: `${BASE}/signoff`, label: '進度' }}
              tint="lilac"
              className="h-full"
            >
              {ready.length + waiting.length === 0 ? (
                <PanelEmpty>指導的組別還沒有進行中的同意書。</PanelEmpty>
              ) : (
                <ul className="pb-2">
                  {ready.map((c) => (
                    <ListRow
                      key={c.current.versionId}
                      code={c.groupCode}
                      title={PURPOSE_LABEL[c.purpose]}
                      sub="學生都同意了・輪到你"
                      trailing={
                        <Link href={`${BASE}/signoff`} className="rounded-lg border border-border bg-card px-3 py-1 text-[13px] font-semibold hover:bg-accent">
                          去看同意書
                        </Link>
                      }
                    />
                  ))}
                  {waiting.map((c) => (
                    <ListRow key={c.current.versionId} code={c.groupCode} title={PURPOSE_LABEL[c.purpose]} sub={`還有 ${c.current.progress.total - c.current.progress.agreed} 位同學未同意`} />
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <div className="min-w-0">
            {/* advisors.spec 用 `home-advised` 斷言指導組數。 */}
            <Panel title="指導中的組別" description={`我的 ${advised} 組`} action={{ href: `${BASE}/groups`, label: '總覽' }} className="h-full" testId="home-advised">
              {myGroups.length === 0 ? (
                <PanelEmpty>
                  {advised > 0 ? `你指導 ${advised} 組（不在後台預設查看的屆別）。` : '還沒有指導的組別。產學組可到「分組」擔任指導老師；一般組由系辦指派。'}
                </PanelEmpty>
              ) : (
                <ul className="pb-2">
                  {myGroups.map((g) => (
                    <ListRow
                      key={g.id}
                      code={g.code}
                      title={g.opportunity?.name ?? g.members.map((m) => m.name).join('、')}
                      trailing={g.groupType === 'industry' ? <Pill>產學</Pill> : null}
                    />
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <div className="min-w-0">
            <Panel title="合作案" description={`我的 ${myCases.length} 件`} action={{ href: `${BASE}/industry`, label: '管理' }} className="h-full">
              {myCases.length === 0 ? (
                <PanelEmpty>還沒有建立合作案。到「產學合作」新增。</PanelEmpty>
              ) : (
                <ul className="pb-2">
                  {myCases.map((c) => (
                    <ListRow
                      key={c.id}
                      title={c.fields.companyName}
                      sub={c.fields.department}
                      trailing={
                        c.links.length > 0 ? <Pill>已有 {c.links.length} 組</Pill> : c.status === 'draft' ? <Pill>草稿</Pill> : <Pill tone="brand">尚未指派</Pill>
                      }
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
