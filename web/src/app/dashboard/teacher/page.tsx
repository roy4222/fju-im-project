import Link from 'next/link'
import { IconChecklist } from '@tabler/icons-react'
import { requireRole } from '@/app/_ui/guard'
import { HomeHero, loadStage } from '@/app/dashboard/_stage'
import { Donut, LegendRow, ListRow, Panel, PanelEmpty, Pill } from '@/app/dashboard/_home'
import { DashboardShell } from '@/app/_ui/site-shell'
import { TEACHER_NAV } from '@/app/dashboard/_nav'
import { getGradingQuery } from '@/composition/grading'
import { getGroupQuery, getOpportunityQuery } from '@/composition/groups'
import { getSignoffQuery, PURPOSE_LABEL } from '@/composition/signoff'
import { cn } from '@/shared/cn'

export const metadata = { title: '老師首頁｜資管系專題平台' }

const BASE = '/dashboard/teacher'

/**
 * 老師首頁（2026-09-25 外觀對齊原型 `home-teacher`，區塊與順序照原型）：
 * 歡迎色塊（現在階段、本屆進度、繼續評分、四格摘要）＋評分進度 → 評分工作台＋可認領產學組 → 同意書＋指導組別＋合作案。
 * Roy 2026-09-10：老師不要行事曆／公告／時間軸。
 *
 * 讀取全部是既有、以老師本人為範圍的查詢：評分只回本人的有效指派、簽核只回本人此刻指導的組、
 * 合作案只列本人建立的；組別清單是「所有老師都可查看」的那一份（跟「分組」頁同一個查詢）。
 */
export default async function TeacherHomePage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住，App Router 會把 layout 與 page 並行渲染，
  // layout 丟掉 children 或 redirect 都來不及——那一頁已經被做出來、跟著 payload 送走了。
  const actor = await requireRole(BASE, 'teacher')
  const me = actor.kind === 'authenticated' ? actor.userId : ''
  const ctx = await loadStage(actor, 'staff')

  const [queue, signCards, groups, cases, advised] = await Promise.all([
    getGradingQuery().teacherQueue(actor),
    getSignoffQuery().teacherView(actor),
    ctx.cohort ? getGroupQuery().cohortGroups(ctx.cohort.id) : Promise.resolve([]),
    getOpportunityQuery().manageList(actor),
    getGroupQuery().advisedGroupCount(me),
  ])

  const counts = {
    empty: queue.filter((e) => e.state === 'empty').length,
    draft: queue.filter((e) => e.state === 'draft').length,
    counted: queue.filter((e) => e.state === 'counted').length,
  }
  const remaining = counts.empty + counts.draft
  // 待我同意＝輪到老師、而且我是這一版的主指導、還沒表態（票 26 卡片的「輪到你」）。
  const ready = signCards.filter((c) => c.current.state === 'teacher_pending' && c.mine.isSnapshotAdvisor && c.mine.voted === null)
  const waiting = signCards.filter((c) => c.current.state === 'collecting')
  const claimable = groups.filter((g) => g.groupType === 'industry' && g.advisor === null)
  const myGroups = groups.filter((g) => g.advisor?.teacherUserId === me)
  const myCases = cases.filter((c) => c.ownerUserId === me && c.status !== 'withdrawn')

  // 原型「歡迎回來，陳建宏 老師」；姓名本身已經以「老師」結尾就不再加。
  const own = actor.kind === 'authenticated' ? actor.displayName : undefined
  const name = own ? (own.endsWith('老師') ? own : `${own} 老師`) : '老師'
  const line = remaining ? `評分還有 ${remaining} 份沒正式送出：未開始 ${counts.empty}、暫存 ${counts.draft}。` : queue.length ? '評分都正式送出了。' : ''

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
            { label: '暫存', value: `${counts.draft} 份`, href: `${BASE}/grading` },
            { label: '已送出', value: `${counts.counted} 份`, href: `${BASE}/grading` },
            { label: '待我同意', value: `${ready.length} 組`, href: `${BASE}/signoff`, hot: ready.length > 0 },
          ]}
        />

        <div className="min-w-0">
          <Panel title="評分進度" description="被指派的評分" className="h-full">
            <div className="flex items-center gap-5 px-5 pt-1 pb-4">
              <Donut
                label={`已送出 ${counts.counted}、暫存 ${counts.draft}、未開始 ${counts.empty}`}
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
                <LegendRow color="var(--primary)" label="暫存" value={counts.draft} />
                <LegendRow color="var(--border)" label="未開始" value={counts.empty} />
              </ul>
            </div>
            <p className="border-t border-border/70 px-5 py-3 text-xs text-muted-foreground">正式送出後鎖定；要改請系辦退回。</p>
          </Panel>
        </div>

        <div className="grid grid-flow-dense grid-cols-[minmax(0,1fr)] gap-5 md:grid-cols-3 xl:col-span-2">
          <div className="min-w-0 md:col-span-2">
            <Panel
              title="評分工作台"
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
                      sub={`${e.cohortCode}・已填 ${e.filled}／${e.total} 項`}
                      trailing={
                        <>
                          {e.state === 'empty' ? <Pill>未開始</Pill> : e.state === 'draft' ? <Pill tone="brand">暫存</Pill> : <Pill tone="success">已送出</Pill>}
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

          <div className="min-w-0">
            {/* 「可認領產學組」只有老師看得到：pages.spec 的直接打 HTTP 回歸測試用它當指紋。 */}
            <Panel
              title="可認領產學組"
              description={`全體 ${claimable.length} 組・先按先得`}
              action={{ href: `${BASE}/groups`, label: '全部' }}
              tint="mint"
              className="h-full"
            >
              {claimable.length === 0 ? (
                <PanelEmpty>目前沒有等待認領的產學組。</PanelEmpty>
              ) : (
                <ul className="pb-2">
                  {claimable.slice(0, 5).map((g) => (
                    <ListRow
                      key={g.id}
                      code={g.code}
                      title={g.opportunity?.name ?? `${g.members.length} 人`}
                      trailing={
                        <Link href={`${BASE}/groups`} className="rounded-lg border border-border bg-card px-3 py-1 text-[13px] font-semibold hover:bg-accent">
                          認領
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
              description={`待我同意 ${ready.length} 組・等待學生 ${waiting.length} 組`}
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
                          去簽核
                        </Link>
                      }
                    />
                  ))}
                  {waiting.map((c) => (
                    <ListRow key={c.current.versionId} code={c.groupCode} title={PURPOSE_LABEL[c.purpose]} sub={`等待學生同意・${c.current.studentCount} 人`} />
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
                  {advised > 0 ? `你指導 ${advised} 組（不在目前工作屆別）。` : '還沒有指導的組別。產學組可到「分組」認領；一般組由系辦指派。'}
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
