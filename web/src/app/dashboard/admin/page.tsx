import Link from 'next/link'
import { IconAlertTriangle, IconChecklist, IconDatabase, IconPencilPlus, IconSignature, IconUserQuestion } from '@tabler/icons-react'
import type { Completion } from '@/application/submissions'
import { requireRole } from '@/app/_ui/guard'
import { HomeHero, loadStage } from '@/app/dashboard/_stage'
import { Donut, LegendRow, ListRow, Meter, Panel, PanelEmpty, Pill } from '@/app/dashboard/_home'
import { DashboardShell } from '@/app/_ui/site-shell'
import { Tile } from '@/app/_ui/primitives'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { getAccountDirectoryCommand } from '@/composition/accounts'
import { getGradingQuery } from '@/composition/grading'
import { getGroupQuery } from '@/composition/groups'
import { collectsResponses, getItemQuery } from '@/composition/items'
import { getOpsStatusQuery } from '@/composition/ops'
import { getSignoffQuery } from '@/composition/signoff'
import { completionOf, getRosterQuery, overdueReceiverIds } from '@/composition/submissions'
import { formatTaipeiDate, taipeiDateOf } from '@/shared/time'

export const metadata = { title: '系辦首頁｜資管系專題平台' }

const BASE = '/dashboard/admin'
/** 首頁的完成率列表最多列幾份收件；更多的到「專題事務」看。逾期磚不受這個限制（掃全部發布中的收件）。 */
const INTAKE_LIMIT = 6

/**
 * 管理員首頁（2026-09-25 外觀對齊原型 `home-admin`，區塊與順序照原型）：
 * 一列歡迎＋現在階段 → 四磚待處理（＋儲存與備份）→ 各收件項目完成率＋本屆分組 → 老師評分進度＋我發的公告。
 *
 * 每個數字都接到真的處理路徑（原型 Codex A-05），讀取全部走既有的 composition 查詢，
 * 都是管理員才讀得到的（頁面守門，用例與查詢自己再判一次）。沒有資料時區塊照樣在，顯示 0 或一句空狀態。
 * 原型的「催繳」按鈕還沒有這個功能，不放假按鈕。
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

  // 發布中的收件全部讀名單：逾期磚要看全部（Codex P2：只掃前 6 份會漏算），完成率列表只列前 INTAKE_LIMIT 份。
  // 跟名單頁同一份名單、同一個 `completionOf`（分母不含免填與移出）。
  const publishedIntake = items.filter((i) => collectsResponses(i.placement) && i.status === 'published')
  const rosterQuery = getRosterQuery()
  const rosters = (await Promise.all(publishedIntake.map((i) => rosterQuery.roster(actor, i.id)))).filter((r) => r !== null)
  const allIntake: { id: string; title: string; unit: string; completion: Completion }[] = rosters.map((r) => ({
    id: r.item.itemId,
    title: r.item.title,
    unit: r.item.receiverUnit === 'individual' ? '人' : '組',
    completion: completionOf(r.item, r.entries, ctx.businessNow),
  }))
  const intake = allIntake.slice(0, INTAKE_LIMIT)
  // 逾期：全部發布中收件上「截止了還沒正式送出」的收件者（人或組），同一位只算一次。
  const overdueReceivers = overdueReceiverIds(rosters, ctx.businessNow)
  const worstOverdue = [...allIntake].sort((a, b) => b.completion.overdue - a.completion.overdue)[0]

  // 本屆分組
  const groups = overview?.groups ?? []
  const industry = groups.filter((g) => g.groupType === 'industry').length
  const noAdvisorIndustry = groups.filter((g) => g.groupType === 'industry' && g.advisor === null).length
  const ungrouped = overview?.ungrouped.length ?? 0
  const openProposals = overview?.openProposals.length ?? 0
  const students = groups.reduce((a, g) => a + g.members.length, 0)

  // 評分：以老師為單位（被指派幾份、正式送出幾份），停用的老師也列出來。
  const byTeacher = new Map<string, { userId: string; name: string; assigned: number; counted: number; inactive: boolean }>()
  for (const a of grading?.assignments ?? []) {
    const row = byTeacher.get(a.teacherUserId) ?? { userId: a.teacherUserId, name: a.teacherName, assigned: 0, counted: 0, inactive: a.teacherInactive }
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
  const news = items.filter((i) => i.placement === 'news')
  const todo = pendingApps + overdueReceivers.size + missingTeachers + waitTeacher

  const name = actor.kind === 'authenticated' && actor.displayName ? actor.displayName : '系辦'
  const line = ctx.cohort ? `今天 ${todo} 件待處理；本屆 ${groups.length} 組、${students} 位學生已分組、${ungrouped} 位未分組。` : ''

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current={BASE}>
      <div className="flex flex-col gap-5">
        <HomeHero
          ctx={ctx}
          perspective="staff"
          name={name}
          line={line}
          compact
          cta={{ href: `${BASE}/accounts?status=pending`, label: `審核帳號（${pendingApps}）` }}
        />

        {/* 四磚＝四條處理路徑，數字旁寫母數與範圍；最後一格是儲存用量（票 28）。 */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          <Tile
            label="審核帳號"
            icon={<IconUserQuestion />}
            tone={pendingApps > 0 ? 'brand' : 'default'}
            value={summary ? pendingApps : '—'}
            of={summary ? `${summary.pending + summary.active + summary.disabled} 個帳號` : undefined}
            hint={summary ? `已核准學生 ${summary.activeStudents} 位` : '讀不到帳號統計'}
            href={`${BASE}/accounts?status=pending`}
          />
          <Tile
            label="逾期未繳"
            icon={<IconAlertTriangle />}
            tone={overdueReceivers.size > 0 ? 'danger' : 'default'}
            value={overdueReceivers.size}
            of={`${allIntake.length} 份收件`}
            hint={worstOverdue && worstOverdue.completion.overdue > 0 ? worstOverdue.title : '目前沒有逾期的收件'}
            href={worstOverdue && worstOverdue.completion.overdue > 0 ? `${BASE}/affairs/${worstOverdue.id}` : `${BASE}/affairs`}
          />
          <Tile
            label="缺評老師"
            icon={<IconChecklist />}
            value={missingTeachers}
            of={`${teachers.length} 位`}
            hint={assigned ? `評分 ${counted}／${assigned} 份・${Math.round((counted / assigned) * 100)}%` : '還沒有指派評分'}
            href={`${BASE}/grading`}
          />
          <Tile
            label="等老師簽核"
            icon={<IconSignature />}
            value={waitTeacher}
            of={`${groups.length} 組`}
            hint={`完成 ${signComplete} 組`}
            href={`${BASE}/signoff`}
          />
          <Tile label="儲存與備份" icon={<IconDatabase />} value={storage.value} hint={storage.hint} />
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)] gap-5 md:grid-cols-3">
          <div className="min-w-0 md:col-span-2">
            {/* 「各收件項目完成率」只有管理員看得到：pages.spec 的直接打 HTTP 回歸測試用它當指紋。 */}
            <Panel title="各收件項目完成率" description="點一列看未繳名單" action={{ href: `${BASE}/affairs`, label: '工作台' }} className="h-full">
              {intake.length === 0 ? (
                <PanelEmpty>本屆還沒有發布中的收件。到「專題事務」新增文件繳交後，這裡會顯示每一份的完成率。</PanelEmpty>
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
              description={`${groups.length} 組・${students} 人`}
              action={{ href: `${BASE}/groups`, label: '總覽' }}
              className="h-full"
            >
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
                    <Link href={`${BASE}/industry`} className="hover:underline">
                      產學未指派
                    </Link>
                    <b className="tabular-nums">{noAdvisorIndustry}</b>
                  </li>
                  <li className="flex items-center justify-between">
                    <Link href={`${BASE}/groups`} className="hover:underline">
                      未分組學生
                    </Link>
                    <b className="tabular-nums">{ungrouped}</b>
                  </li>
                  <li className="flex items-center justify-between">
                    <Link href={`${BASE}/groups`} className="hover:underline">
                      進行中提案
                    </Link>
                    <b className="tabular-nums">{openProposals}</b>
                  </li>
                </ul>
              </div>
            </Panel>
          </div>

          <div className="min-w-0 md:col-span-2">
            <Panel
              title="老師評分進度"
              description={`${counted}／${assigned} 份`}
              action={{ href: `${BASE}/grading`, label: '成績' }}
              className="h-full"
            >
              {teachers.length === 0 ? (
                <PanelEmpty>還沒有指派評分。到「成績」頁設定評分方案與指派老師後，這裡會列出每位老師的進度。</PanelEmpty>
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
                        <tr key={t.userId} className="border-t border-border/70">
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
              title="我發的公告"
              description={`${news.length} 則`}
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
                  {news.slice(0, 5).map((n) => (
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
