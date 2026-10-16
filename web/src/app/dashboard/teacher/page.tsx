import Link from 'next/link'
import { IconChevronRight } from '@tabler/icons-react'
import { requireRole } from '@/app/_ui/guard'
import { HomeHero } from '@/app/dashboard/_stage'
import { ListRow, Panel, PanelEmpty } from '@/app/dashboard/_home'
import { DashboardShell } from '@/app/_ui/site-shell'
import { TEACHER_NAV } from '@/app/dashboard/_nav'
import { loadTeacherHome } from '@/app/dashboard/teacher/_home/load'
import { missingSubmissions } from '@/app/dashboard/teacher/_home/missing'
import { TodoPanels } from '@/app/dashboard/teacher/_home/todo-panels'
import { teacherSignoffSummary } from '@/app/dashboard/teacher/signoff-summary'
import { AUDIENCE_LABEL } from '@/composition/items'
import { taipeiDateOf, taipeiTimeOf } from '@/shared/time'

export const metadata = { title: '老師首頁｜資管系專題平台' }

const BASE = '/dashboard/teacher'

/**
 * 老師首頁（老師規格 §4.1，Q77；TE-07）：三段。
 *
 * 1. 「現在」橫幅：階段句＋「待評 N 組・已評 x／y」，唯一的行動鍵「繼續評分」（N＝0 不放，Q47）。
 *    N 與側欄「評分」徽章同一條規則（沒正式送出的指派數）。共用 SH-4 的新 `HomeHero`（`timelineHref`、`trail`）
 *    還沒合併，先用舊的、不傳那兩個；也不傳已不用的進度條、小格、插圖。
 * 2. 待辦：待評分、待我同意的同意書、缺件的組（`_home/todo-panels.tsx`）。
 * 3. 公告：「給老師的公告」（全部老師、所有已登入、我指導的組，新到舊 5 則）與「本屆活動」（Q13、Q14）。
 *
 * 拿掉的：評分圓環、四個小格、「我的評分」清單、待指導的產學組、指導中的組別、合作案（後兩者在分組總覽）。
 * 資料只從 `loadTeacherHome` 拿（一次 `Promise.all`）。
 */
export default async function TeacherHomePage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住，App Router 會把 layout 與 page 並行渲染，
  // layout 丟掉 children 或 redirect 都來不及——那一頁已經被做出來、跟著 payload 送走了。
  const actor = await requireRole(BASE, 'teacher')
  const { stage: ctx, workload, queue, signoffCards, matrix, news, activities } = await loadTeacherHome(actor)

  const counted = queue.length - workload.toGrade
  const line = queue.length ? `待評 ${workload.toGrade} 組・已評 ${counted}／${queue.length}` : '這一階段沒有你的評分指派'
  const { ready } = teacherSignoffSummary(signoffCards)
  const missing = missingSubmissions(matrix, ctx.businessNow)

  // 原型「歡迎回來，陳建宏 老師」；姓名本身已經以「老師」結尾就不再加。
  const own = actor.kind === 'authenticated' ? actor.displayName : undefined
  const name = own ? (own.endsWith('老師') ? own : `${own} 老師`) : '老師'

  return (
    <DashboardShell roleLabel="老師" items={TEACHER_NAV} current={BASE}>
      <div className="flex min-w-0 flex-col gap-6">
        <HomeHero
          ctx={ctx}
          perspective="staff"
          name={name}
          line={line}
          cta={workload.toGrade ? { href: `${BASE}/grading`, label: '繼續評分' } : undefined}
        />

        <TodoPanels queue={queue} ready={ready} missing={missing} />

        {/* 公告區：左「給老師的公告」、右「本屆活動」（窄螢幕上下排）。 */}
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 md:grid-cols-2">
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
            description={activities.advisedCohorts.length > 0 ? '我指導的屆別' : ctx.cohort?.name}
            testId="home-cohort-activities"
            className="h-full"
          >
            {activities.upcoming.length === 0 ? (
              <PanelEmpty>
                {activities.advisedCohorts.length > 0
                  ? '你指導的屆別接下來沒有排定的活動。'
                  : ctx.cohort
                    ? '接下來沒有給老師的活動。指導某一屆的組別後，也會列出給那屆學生的活動。'
                    : '還沒有指導的組別，系辦也還沒設定後台預設查看的屆別。'}
              </PanelEmpty>
            ) : (
              <ul className="pb-2">
                {activities.upcoming.map((a) => (
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
      </div>
    </DashboardShell>
  )
}
