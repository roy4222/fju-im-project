import Link from 'next/link'
import { IconAlertTriangle } from '@tabler/icons-react'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { ClearFilters, DataTableFrame, DataTableToolbar, DT, EmptyRow } from '@/app/_ui/data-table'
import { FacetMenu } from '@/app/_ui/data-table-facet'
import { CohortPills, PageTitle, Panel, PanelEmpty, Pill, QuietState } from '@/app/_ui/dashboard/primitives'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { AdminTabs } from '@/app/dashboard/admin/_tabs'
import { teacherProgress } from '@/app/dashboard/admin/grading/progress'
import { GradeExportButtons } from '@/app/dashboard/admin/grading/results-forms'
import type { Gradebook } from '@/application/grading'
import { cohortLabel, getCohortStatusQuery } from '@/composition/cohorts'
import {
  adoptedFinal,
  describeMissing,
  describeOverride,
  deriveStageRows,
  describeStageStatus,
  getGradingSnapshotQuery,
  normalizeGradeExportFilter,
  selectExportGroups,
  unassignedSlots,
} from '@/composition/grading'
import { cn } from '@/shared/cn'

export const metadata = { title: '成績｜資管系專題平台' }

const BASE = '/dashboard/admin/grading'
const RULES = `${BASE}/rules`

/** 「成績」側欄項底下的分頁（設計方案 §3.4）；評分規則是子頁連結，不是分頁。 */
const TABS = [
  { href: BASE, label: '成績管理' },
  { href: `${BASE}/settle`, label: '結算' },
  { href: '/dashboard/admin/signoff', label: '同意書' },
] as const

/**
 * 系辦「成績」分頁（AD-08；設計方案 §3.4）：只留三件事——評分進度卡片、成績表（篩選與匯出）、需要重新確認的更正。
 * 評分規則、版本紀錄、每組要幾份評分與指派都在子頁 `/dashboard/admin/grading/rules`（一年用一兩次）。
 *
 * 讀取兩次：屆別清單、屆別評分快照（`cohortSnapshot`，B 階段 TE-B6）——老師評分進度用快照的 `board`，
 * 階段完成率、成績表、更正用快照的 `gradebook`，同一份資料只讀一次（≤32 句 SQL，AC-A-15）。
 * 老師評分進度與首頁同一個 `teacherProgress()`（AC-AD-03），階段膠囊預設「全部階段」（Q115）。
 * 計算明細、退回、更正與復核在 `/dashboard/admin/grading/<組別>`。
 */
export default async function AdminGradingPage({
  searchParams,
}: {
  searchParams: Promise<{
    cohort?: string | string[]
    stage?: string | string[]
    fstage?: string | string[]
    fgroup?: string | string[]
    fstatus?: string | string[]
    applied?: string | string[]
  }>
}) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole(BASE, 'admin')

  // 封存的屆別也可選（產品模組 02 §11.3「封存後…管理員可查與匯出」）：只能看與匯出。
  const cohorts = await getCohortStatusQuery().list()
  const params = await searchParams
  const cohort =
    cohorts.find((c) => c.id === params.cohort) ??
    cohorts.find((c) => c.isDefaultWorking) ??
    cohorts.find((c) => c.status !== 'archived') ??
    cohorts[0] ??
    null

  const shell = (children: React.ReactNode) => (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current={BASE}>
      <div className="flex flex-col gap-5">
        <div>
          <PageTitle title="成績" />
          <AdminTabs
            label="成績分頁"
            current={BASE}
            items={TABS}
            actions={
              <Link
                href={cohort ? `${RULES}?cohort=${cohort.id}` : RULES}
                className="inline-flex min-h-9 items-center px-2 text-sm font-semibold text-primary underline-offset-2 hover:underline"
              >
                評分規則<span aria-hidden>&nbsp;↗</span>
              </Link>
            }
          />
        </div>
        {/* 屆別膠囊獨立一列：測試站屆別多，跟分頁擠同一列會把分頁推亂（網站問題 #8）。 */}
        {cohort ? (
          <CohortPills
            cohorts={cohorts.map((c) => ({ id: c.id, code: c.status === 'archived' ? `${cohortLabel(c)}・已封存` : cohortLabel(c) }))}
            currentId={cohort.id}
            hrefFor={(id) => `${BASE}?cohort=${id}`}
          />
        ) : null}
        {children}
      </div>
    </DashboardShell>
  )

  if (!cohort) {
    return shell(
      <QuietState
        title="還沒有屆別"
        action={
          <Link href="/dashboard/admin/cohorts" className="text-sm font-semibold text-primary hover:underline">
            前往屆別
          </Link>
        }
      />,
    )
  }

  const snapshot = await getGradingSnapshotQuery().cohortSnapshot(actor, cohort.id)
  if (!snapshot.ok) return shell(<QuietState title="讀不到評分資料" hint={snapshot.message} />)
  const { board, gradebook } = snapshot.receipt
  // 成績表的篩選與匯出同一份（屆別＋階段＋組別＋完成狀態；伺服器重新算）。
  const filter = normalizeGradeExportFilter({ stage: params.fstage, group: params.fgroup, status: params.fstatus })
  const { current } = board
  // 伺服器端的屆別狀態為準。
  const archived = board.cohort.archived
  const stages = current?.stages ?? []
  // 階段膠囊：預設「全部階段」（Q115）；選了某階段，階段卡與老師卡都只算那一階段。
  const stage = stages.find((s) => s.key === params.stage) ?? null

  // 各階段完成率（解散的組不算；見 `deriveStageRows`）。
  const stageRows = deriveStageRows(snapshot.receipt, stage?.key ?? null)
  const teachers = teacherProgress(board, { ...(stage ? { stageKey: stage.key } : {}), excludeDissolved: true })

  return shell(
    <>
      {archived ? (
        <p role="status" data-testid="cohort-archived" className="rounded-lg bg-muted px-4 py-2.5 text-sm text-muted-foreground">
          {cohortLabel(board.cohort)}已封存，只能查看與匯出；要修改請先解封。
        </p>
      ) : null}

      {current && params.applied === String(current.versionNo) ? (
        <p role="status" className="rounded-lg bg-brand-subtle px-4 py-2.5 text-sm text-brand-on-subtle">
          已套用評分規則第 {current.versionNo} 版：各組成績照新版本重算，新版本已鎖定。{' '}
          <Link href={`${RULES}?cohort=${cohort.id}`} className="font-semibold underline-offset-2 hover:underline">
            看評分規則
          </Link>
        </p>
      ) : null}

      {current ? (
        <section aria-label="評分進度" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <h2 className="text-[15px] font-bold text-foreground">評分進度</h2>
            <nav aria-label="評分進度階段" className="flex flex-wrap gap-1">
              {[{ key: null as string | null, name: '全部階段' }, ...stages.map((s) => ({ key: s.key as string | null, name: s.name }))].map((s) => {
                const on = (stage?.key ?? null) === s.key
                return (
                  <Link
                    key={s.key ?? 'all'}
                    href={`${BASE}?cohort=${cohort.id}${s.key ? `&stage=${s.key}` : ''}`}
                    aria-current={on ? 'page' : undefined}
                    className={cn(
                      'inline-flex h-8 items-center rounded-full border px-3 text-sm font-semibold transition-colors',
                      on ? 'border-ink bg-ink text-ink-foreground' : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
                    )}
                  >
                    {s.name}
                  </Link>
                )
              })}
            </nav>
          </div>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {stageRows.map((r) => (
              <ProgressCard key={`stage-${r.key}`} testId={`stage-progress-${r.key}`} label={r.name} done={r.done} total={r.total} />
            ))}
            {teachers.map((t) => (
              <ProgressCard
                key={`teacher-${t.userId}`}
                testId="teacher-progress"
                label={t.name}
                tag={t.inactive ? '已停用' : null}
                done={t.counted}
                total={t.assigned}
              />
            ))}
          </ul>
        </section>
      ) : null}

      <GradebookSection book={gradebook} filter={filter} />
    </>,
  )
}

/** 評分進度的一張小卡：名稱、已送出 x／y、進度條（階段一張、老師一張）。 */
function ProgressCard({ label, tag, done, total, testId }: { label: string; tag?: string | null; done: number; total: number; testId: string }) {
  const p = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  return (
    <li data-testid={testId} className="dash-card flex flex-col gap-2 px-4 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-semibold text-foreground">{label}</span>
          {tag ? <Pill tone="danger">{tag}</Pill> : null}
        </span>
        <span className="tabular shrink-0 text-sm font-bold text-foreground">
          {done}／{total}
        </span>
      </div>
      <svg width="100%" height="8" className="block" aria-hidden>
        <rect width="100%" height="8" rx="4" className="fill-muted" />
        {p > 0 ? <rect width={`${p}%`} height="8" rx="4" className={done >= total ? 'fill-success' : 'fill-brand'} /> : null}
      </svg>
    </li>
  )
}

const LINK_BUTTON =
  'inline-flex h-7 items-center justify-center rounded-lg border border-border bg-background px-2.5 text-[0.8rem] font-medium whitespace-nowrap text-foreground hover:bg-muted'

const STATUS_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'complete', label: '已完成' },
  { value: 'incomplete', label: '尚未完成' },
] as const

/**
 * 成績表（票 24；產品 06 §4「7.3」「7.4」、GRD-05／06／10）：各組各階段平均與最終（兩位小數）、完成狀態、
 * 更正註記、缺評待處理（老師停用）。篩選與匯出同一份；數字與匯出檔一致。
 * 表格維持（Q89）；不設最小寬度，1280 寬不溢出（AC-AD-23）。「需要重新確認的更正」放在表下，一筆一張卡。
 */
function GradebookSection({ book, filter }: { book: Gradebook; filter: ReturnType<typeof normalizeGradeExportFilter> }) {
  const stages = book.version?.stages ?? []
  const shown = selectExportGroups(book, filter)
  const visibleStages = filter.stageKey === 'all' ? stages : stages.filter((s) => s.key === filter.stageKey)
  const base = `${BASE}?cohort=${book.cohort.id}`
  const href = (patch: { fstage?: string; fgroup?: string; fstatus?: string }) => {
    const q = new URLSearchParams({ cohort: book.cohort.id })
    const next = { fstage: filter.stageKey, fgroup: filter.groupId, fstatus: filter.status, ...patch }
    for (const [k, v] of Object.entries(next)) if (v && v !== 'all') q.set(k, v)
    return `${BASE}?${q.toString()}`
  }
  const filtered = filter.stageKey !== 'all' || filter.groupId !== 'all' || filter.status !== 'all'
  return (
    <>
      <Panel title="成績表" aria-label="成績表" bodyClassName="px-4 pb-4">
        {!book.version ? (
          <PanelEmpty
            title="還沒有發布的評分規則"
            action={
              <Link href={`${RULES}?cohort=${book.cohort.id}`} className="text-sm font-semibold text-primary hover:underline">
                前往評分規則
              </Link>
            }
          />
        ) : (
          <div className="space-y-3">
            <DataTableToolbar>
              <FacetMenu
                label="階段"
                value={filter.stageKey}
                allValue="all"
                options={[
                  { value: 'all', label: '全部階段', href: href({ fstage: 'all' }) },
                  ...stages.map((s) => ({ value: s.key, label: s.name, href: href({ fstage: s.key }) })),
                ]}
              />
              <FacetMenu
                label="組別"
                value={filter.groupId}
                allValue="all"
                options={[
                  { value: 'all', label: '全部組別', href: href({ fgroup: 'all' }) },
                  ...book.groups.map((g) => ({ value: g.id, label: g.dissolved ? `${g.code}（已解散）` : g.code, href: href({ fgroup: g.id }) })),
                ]}
              />
              <FacetMenu
                label="完成狀態"
                value={filter.status}
                allValue="all"
                options={STATUS_FILTERS.map((f) => ({ value: f.value, label: f.label, href: href({ fstatus: f.value }) }))}
              />
              {filtered ? <ClearFilters href={base} /> : null}
              <div className="ml-auto">
                <GradeExportButtons
                  cohortId={book.cohort.id}
                  filter={{ stage: filter.stageKey, group: filter.groupId, status: filter.status }}
                  disabled={shown.length === 0}
                />
              </div>
            </DataTableToolbar>
            <DataTableFrame>
              <table aria-label="成績表" className={DT.table}>
                <thead className={DT.thead}>
                  <tr>
                    <th className={DT.th}>組別</th>
                    {visibleStages.map((s) => (
                      <th key={s.key} className={`${DT.th} text-right`}>
                        {s.name}（{s.weight}%）
                      </th>
                    ))}
                    <th className={`${DT.th} text-right`}>最終成績</th>
                    <th className={DT.th}>註記</th>
                    <th className={DT.th}>
                      <span className="sr-only">明細</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.length === 0 ? (
                    <EmptyRow colSpan={visibleStages.length + 4} title="沒有符合條件的組別" hint="試著放寬篩選條件。" />
                  ) : (
                    shown.map((g) => {
                      const adopted = adoptedFinal(g.result, g.override)
                      const notes = [
                        describeOverride(g.override),
                        ...g.missing.filter((m) => m.teacherInactive && (filter.stageKey === 'all' || m.stageKey === filter.stageKey)).map(describeMissing),
                        ...unassignedSlots(g, filter.stageKey),
                      ].filter(Boolean)
                      return (
                        <tr key={g.id} className={`${DT.tr} align-top`} data-testid={`gradebook-row-${g.code}`}>
                          <td className={DT.td}>
                            <p className="tabular font-bold text-foreground">{g.code}</p>
                            {g.dissolved ? (
                              <p className="mt-0.5">
                                <Pill tone="default">已解散・唯讀{g.versionNo !== null && g.versionNo !== book.version?.versionNo ? `・評分規則第 ${g.versionNo} 版` : ''}</Pill>
                              </p>
                            ) : (
                              <p className="text-xs text-muted-foreground">指導：{g.advisorName ?? '尚未指派'}</p>
                            )}
                          </td>
                          {visibleStages.map((v) => {
                            // 解散的組用解散當下的版本算，可能沒有目前版本新加的階段：留一格空的，欄位才對得齊。
                            const s = g.result.stages.find((x) => x.key === v.key)
                            if (!s) {
                              return (
                                <td key={v.key} className={`${DT.td} text-right text-sm text-muted-foreground`} data-testid={`stage-${v.key}`}>
                                  —
                                </td>
                              )
                            }
                            return (
                              <td key={s.key} className={`${DT.td} text-right`} data-testid={`stage-${s.key}`}>
                                <p className={cn('tabular-nums', s.complete ? 'text-base font-extrabold text-foreground' : 'text-sm font-semibold text-muted-foreground')}>
                                  {s.averageDisplay ?? '—'}
                                </p>
                                <p className="mt-0.5">
                                  <Pill tone={s.complete ? 'success' : s.counted.length > 0 ? 'brand' : 'default'}>{describeStageStatus(s)}</Pill>
                                </p>
                                {s.name !== v.name || s.weight !== v.weight ? (
                                  // 解散的組照解散當下的版本算：階段名稱或權重和表頭不同時註明，最終成績才對得起來。
                                  <p className="mt-0.5 text-xs text-muted-foreground">
                                    第 {g.versionNo} 版：{s.name} {s.weight}%
                                  </p>
                                ) : null}
                              </td>
                            )
                          })}
                          <td className={`${DT.td} text-right`} data-testid="final">
                            <p className={cn('tabular-nums', adopted.value ? 'text-base font-extrabold text-foreground' : 'text-sm font-semibold text-muted-foreground')}>
                              {adopted.value ?? '尚未完成'}
                            </p>
                            {adopted.source === 'override' ? <p className="text-xs text-brand-on-subtle">已更正（原 {g.result.finalDisplay}）</p> : null}
                            {adopted.pendingReview ? <p className="text-xs text-destructive">更正需要重新確認</p> : null}
                          </td>
                          <td className={`${DT.td} max-w-[18rem] text-xs`}>
                            {notes.length > 0 ? (
                              <ul className="space-y-0.5">
                                {notes.map((n) => (
                                  <li key={n} className={n.startsWith('已更正') ? 'text-muted-foreground' : 'text-destructive'}>
                                    {n}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className={`${DT.td} text-right`}>
                            <Link href={`${BASE}/${g.id}`} className={LINK_BUTTON}>
                              計算明細
                            </Link>
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </DataTableFrame>
            <p className="tabular text-xs text-muted-foreground" data-testid="gradebook-count">
              顯示 {shown.length}／{book.groups.length} 組
            </p>
          </div>
        )}
      </Panel>

      {book.pendingReviews.length > 0 ? (
        <section aria-label="需要重新確認的更正" className="flex flex-col gap-3">
          <h2 className="text-[15px] font-bold text-foreground">需要重新確認的更正（{book.pendingReviews.length}）</h2>
          <ul className="grid gap-3 md:grid-cols-2">
            {book.pendingReviews.map((p) => (
              <li key={p.overrideId} className="dash-card flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-destructive/40 px-4 py-3 text-sm">
                <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <IconAlertTriangle className="size-4 shrink-0 self-center text-destructive" aria-hidden />
                  <Link href={`${BASE}/${p.groupId}`} className="font-semibold text-foreground underline-offset-2 hover:underline">
                    {p.groupCode}
                  </Link>
                  <span className="tabular-nums text-muted-foreground">
                    原更正 {p.originalValue} → {p.newValue}（{p.reason}）
                  </span>
                </span>
                <Link href={`${BASE}/${p.groupId}`} className="shrink-0 font-semibold text-primary underline-offset-2 hover:underline" aria-label={`去確認 ${p.groupCode} 的更正`}>
                  去確認
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  )
}
