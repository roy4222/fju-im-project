import Link from 'next/link'
import {
  IconChecklist,
  IconDatabase,
  IconPencilPlus,
  IconSignature,
  IconUserExclamation,
  IconUserQuestion,
  IconUsersGroup,
  IconUserCheck,
} from '@tabler/icons-react'
import { requireRole } from '@/app/_ui/guard'
import { HomeHero, loadStage } from '@/app/dashboard/_stage'
import { ActionRow, Donut, LegendRow, ListRow, Meter, Panel, PanelEmpty, Pill } from '@/app/dashboard/_home'
import { DashboardShell } from '@/app/_ui/site-shell'
import { Tile } from '@/app/_ui/primitives'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { getAccountDirectoryCommand } from '@/composition/accounts'
import { getGradingQuery } from '@/composition/grading'
import { getGroupQuery } from '@/composition/groups'
import { getItemQuery } from '@/composition/items'
import { getOpsStatusQuery } from '@/composition/ops'
import { getSignoffQuery } from '@/composition/signoff'
import { formatTaipeiDate, taipeiDateOf } from '@/shared/time'

export const metadata = { title: '系辦首頁｜資管系專題平台' }

const BASE = '/dashboard/admin'

/**
 * 管理員首頁（2026-09-25 外觀對齊原型 `home-admin`）：一列歡迎＋現在階段 → 四磚 → 需要處理＋本屆分組 → 老師評分進度＋公告。
 *
 * 每個數字都接到真的處理路徑（原型 Codex A-05）。只放 web 已經有資料的區塊：
 * 原型的「各收件項目完成率」要逐項讀收件名單、「催繳」還沒有這個功能，先不放。
 * 讀取全部走既有的 composition 查詢；工作屆別的查詢都是管理員才讀得到（頁面守門＋用例自己再判）。
 */
export default async function AdminHomePage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住，App Router 會把 layout 與 page 並行渲染，
  // layout 丟掉 children 或 redirect 都來不及——那一頁已經被做出來、跟著 payload 送走了。
  const actor = await requireRole(BASE, 'admin')
  const ctx = await loadStage(actor, 'staff')
  const cohortId = ctx.cohort?.id ?? null

  const [summaryResult, storage, overview, gradingResult, signoffResult, items] = await Promise.all([
    getAccountDirectoryCommand().summary(actor),
    // 儲存用量（票 28）：背景工作每小時量一次，這裡只讀最新一筆；≥80% 只在這裡標「警戒」，不推播。
    getOpsStatusQuery().storageTile(actor),
    cohortId ? getGroupQuery().overview(cohortId) : Promise.resolve(null),
    cohortId ? getGradingQuery().adminBoard(actor, cohortId) : Promise.resolve(null),
    cohortId ? getSignoffQuery().adminBoard(actor, cohortId) : Promise.resolve(null),
    cohortId ? getItemQuery().list(cohortId) : Promise.resolve([]),
  ])
  const summary = summaryResult.ok ? summaryResult.receipt : null
  const grading = gradingResult?.ok ? gradingResult.receipt : null
  const signoff = signoffResult?.ok ? signoffResult.receipt : null

  // 本屆分組
  const groups = overview?.groups ?? []
  const industry = groups.filter((g) => g.groupType === 'industry').length
  const noAdvisor = groups.filter((g) => g.advisor === null).length
  const ungrouped = overview?.ungrouped.length ?? 0
  const openProposals = overview?.openProposals.length ?? 0
  const students = groups.reduce((a, g) => a + g.members.length, 0)

  // 評分：以老師為單位（被指派幾份、正式送出幾份），停用的老師也列出來。
  const byTeacher = new Map<string, { name: string; assigned: number; counted: number; inactive: boolean }>()
  for (const a of grading?.assignments ?? []) {
    const row = byTeacher.get(a.teacherUserId) ?? { name: a.teacherName, assigned: 0, counted: 0, inactive: a.teacherInactive }
    row.assigned += 1
    if (a.state === 'counted') row.counted += 1
    byTeacher.set(a.teacherUserId, row)
  }
  const teachers = [...byTeacher.values()].sort((a, b) => a.counted / a.assigned - b.counted / b.assigned)
  const assigned = teachers.reduce((a, t) => a + t.assigned, 0)
  const counted = teachers.reduce((a, t) => a + t.counted, 0)
  const missingTeachers = teachers.filter((t) => t.counted < t.assigned).length

  // 簽核：目前那一版停在「等待指導老師」的組別。
  const signGroups = signoff?.groups ?? []
  const waitTeacher = signGroups.filter((g) => Object.values(g.packages).some((p) => p?.state === 'teacher_pending')).length
  const signComplete = signGroups.filter((g) => Object.values(g.packages).some((p) => p?.state === 'complete')).length

  const pendingApps = summary?.pendingApplications ?? 0
  const orphans = summary?.orphans ?? 0
  const news = items.filter((i) => i.placement === 'news').slice(0, 5)

  const todo = [
    { key: 'apps', count: pendingApps, icon: <IconUserQuestion />, label: '審核註冊申請', detail: '核准後學生才能登入使用', href: `${BASE}/accounts?status=pending`, cta: '去審核', tone: 'brand' as const },
    { key: 'orphans', count: orphans, icon: <IconUserExclamation />, label: '孤兒帳號', detail: '沒有任何角色、也不在待審的帳號', href: `${BASE}/accounts?orphan=1`, cta: '查看', tone: 'default' as const },
    { key: 'ungrouped', count: ungrouped, icon: <IconUsersGroup />, label: '未分組學生', detail: `${ctx.cohort?.code ?? ''} 還沒有有效組別的學生`, href: `${BASE}/groups`, cta: '查看', tone: 'default' as const },
    { key: 'proposals', count: openProposals, icon: <IconUsersGroup />, label: '進行中的分組提案', detail: '等組員全員確認', href: `${BASE}/groups`, cta: '查看', tone: 'default' as const },
    { key: 'advisor', count: noAdvisor, icon: <IconUserCheck />, label: '還沒有主指導的組別', detail: '一般組由系辦指派，產學組由老師認領', href: `${BASE}/groups`, cta: '去指派', tone: 'default' as const },
    { key: 'grading', count: assigned - counted, icon: <IconChecklist />, label: '還沒正式送出的評分', detail: `${missingTeachers} 位老師還有沒送出的`, href: `${BASE}/grading`, cta: '查看', tone: 'default' as const },
    { key: 'signoff', count: waitTeacher, icon: <IconSignature />, label: '等老師簽核的組別', detail: '學生都同意了，輪到指導老師', href: `${BASE}/signoff`, cta: '查看', tone: 'default' as const },
  ].filter((t) => t.count > 0)

  const name = actor.kind === 'authenticated' && actor.displayName ? actor.displayName : '系辦'
  const line = ctx.cohort
    ? `今天 ${todo.length} 項待處理；本屆 ${groups.length} 組、${students} 位學生已分組、${ungrouped} 位未分組。`
    : ''

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current={BASE}>
      <div className="flex flex-col gap-5">
        <HomeHero
          ctx={ctx}
          perspective="staff"
          name={name}
          line={line}
          compact
          cta={pendingApps > 0 ? { href: `${BASE}/accounts?status=pending`, label: `審核帳號（${pendingApps}）` } : undefined}
        />

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Tile
            label="待審核申請"
            icon={<IconUserQuestion />}
            tone={pendingApps > 0 ? 'brand' : 'default'}
            value={summary?.pendingApplications ?? '—'}
            hint={summary ? `已核准學生 ${summary.activeStudents} 位` : '讀不到帳號統計'}
            href={`${BASE}/accounts?status=pending`}
          />
          <Tile
            label="未分組學生"
            icon={<IconUsersGroup />}
            value={overview ? ungrouped : '—'}
            of={overview ? `${groups.length} 組已成立` : undefined}
            hint={ctx.cohort ? `${ctx.cohort.code}・進行中提案 ${openProposals} 件` : '到「屆別」頁指定預設工作屆別'}
            href={ctx.cohort ? `${BASE}/groups` : `${BASE}/cohorts`}
          />
          <Tile
            label="缺評老師"
            icon={<IconChecklist />}
            value={grading ? missingTeachers : '—'}
            of={grading ? `${teachers.length} 位` : undefined}
            hint={grading ? `評分 ${counted}／${assigned} 份已正式送出` : '本屆還沒有評分方案'}
            href={`${BASE}/grading`}
          />
          <Tile label="儲存與備份" icon={<IconDatabase />} value={storage.value} hint={storage.hint} />
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)] gap-5 md:grid-cols-3">
          <div className="min-w-0 md:col-span-2">
            {/* 這一段只有管理員看得到：pages.spec 的直接打 HTTP 回歸測試用它當指紋。 */}
            <Panel title="需要處理" description="待審的註冊、分組與評分簽核" className="h-full" testId="admin-todo">
              {todo.length === 0 ? (
                <PanelEmpty>目前沒有要處理的事。有新的註冊申請、未分組學生或沒送出的評分時會出現在這裡。</PanelEmpty>
              ) : (
                <ul>
                  {todo.map((t) => (
                    <ActionRow key={t.key} icon={t.icon} label={t.label} detail={t.detail} count={t.count} href={t.href} cta={t.cta} tone={t.tone} />
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <div className="min-w-0">
            <Panel
              title="本屆分組"
              description={ctx.cohort ? `${groups.length} 組・${students} 人` : undefined}
              action={{ href: `${BASE}/groups`, label: '總覽' }}
              className="h-full"
            >
              {overview ? (
                <div className="flex items-center gap-5 px-5 pt-1 pb-5">
                  <Donut
                    label={`一般專題 ${groups.length - industry} 組、產學合作 ${industry} 組`}
                    segments={[
                      { value: groups.length - industry, color: 'var(--ink)' },
                      { value: industry, color: 'var(--primary)' },
                    ]}
                    center={
                      <span>
                        <span className="block text-[22px] leading-none font-extrabold tabular-nums">{groups.length}</span>
                        <span className="text-[10px] text-muted-foreground">組</span>
                      </span>
                    }
                  />
                  <ul className="flex flex-1 flex-col gap-2 text-sm">
                    <LegendRow color="var(--ink)" label="一般專題" value={groups.length - industry} />
                    <LegendRow color="var(--primary)" label="產學合作" value={industry} />
                    <li className="flex items-center justify-between border-t border-border/70 pt-2">
                      <Link href={`${BASE}/groups`} className="hover:underline">
                        未分組學生
                      </Link>
                      <b className="tabular-nums">{ungrouped}</b>
                    </li>
                    <li className="flex items-center justify-between">
                      <Link href={`${BASE}/groups`} className="hover:underline">
                        沒有主指導
                      </Link>
                      <b className="tabular-nums">{noAdvisor}</b>
                    </li>
                  </ul>
                </div>
              ) : (
                <PanelEmpty>還沒有設定預設工作屆別。到「屆別」頁指定之後，這裡會顯示分組狀況。</PanelEmpty>
              )}
            </Panel>
          </div>

          <div className="min-w-0 md:col-span-2">
            <Panel
              title="老師評分進度"
              description={grading ? `${counted}／${assigned} 份已正式送出` : undefined}
              action={{ href: `${BASE}/grading`, label: '成績' }}
              className="h-full"
            >
              {teachers.length === 0 ? (
                <PanelEmpty>還沒有指派評分。到「成績」頁設定評分方案與指派老師。</PanelEmpty>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm whitespace-nowrap">
                    <thead>
                      <tr className="text-left text-[12px] text-muted-foreground">
                        <th scope="col" className="px-5 py-2 font-semibold">
                          老師
                        </th>
                        <th scope="col" className="px-3 py-2 font-semibold">
                          進度
                        </th>
                        <th scope="col" className="px-3 py-2 font-semibold">
                          送出
                        </th>
                        <th scope="col" className="px-5 py-2">
                          <span className="sr-only">狀態</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {teachers.map((t) => (
                        <tr key={t.name} className="border-t border-border/70">
                          <td className="px-5 py-2.5 font-semibold">
                            {t.name}
                            {t.inactive ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">（已停用）</span> : null}
                          </td>
                          <td className="px-3 py-2.5">
                            <Meter value={t.counted} total={t.assigned} done={t.counted === t.assigned} className="w-32" />
                          </td>
                          <td className="px-3 py-2.5 tabular-nums">
                            {t.counted}／{t.assigned}
                          </td>
                          <td className="px-5 py-2.5 text-right">
                            {t.counted === t.assigned ? <Pill tone="success">完成</Pill> : <Pill>還差 {t.assigned - t.counted} 份</Pill>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          </div>

          <div className="min-w-0">
            <Panel
              title="公告"
              description={ctx.cohort ? `本屆 ${items.filter((i) => i.placement === 'news').length} 則` : undefined}
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
                <PanelEmpty>本屆還沒有公告。</PanelEmpty>
              ) : (
                <ul>
                  {news.map((n) => (
                    <ListRow
                      key={n.id}
                      href={`${BASE}/editor/${n.id}`}
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
