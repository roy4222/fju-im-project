import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { Card, EmptyState, PageHeader } from '@/app/_ui/primitives'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import {
  AssignEvaluatorForm,
  PublishButton,
  RequirementForm,
  SchemeEditor,
} from '@/app/dashboard/admin/grading/grading-forms'
import { GradeExportButtons } from '@/app/dashboard/admin/grading/results-forms'
import type { AdminAssignmentView, Gradebook, SchemeVersionView } from '@/application/grading'
import { getCohortStatusQuery } from '@/composition/cohorts'
import {
  adoptedFinal,
  describeFormula,
  describeMissing,
  describeOverride,
  describeStageStatus,
  EVALUATION_STATE_LABEL,
  getGradebookQuery,
  getGradingQuery,
  ITEM_TYPE_LABEL,
  MAX_REQUIRED_COUNT,
  normalizeGradeExportFilter,
  SCHEME_STATUS_LABEL,
  selectExportGroups,
  unassignedSlots,
} from '@/composition/grading'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute } from '@/shared/time'

export const metadata = { title: '評分管理｜資管系專題平台' }

/**
 * 管理員「評分」（票 23；原型 `/dashboard/admin/grading`）。
 *
 * 由上而下：評分方案（目前版本、公式、版本清單與發布／套用新版本）、待復核的更正、成績表（票 24：各組各階段平均、
 * 最終、完成狀態、篩選與匯出）、每組每階段的要求份數與評分老師（票 24：每位老師可移除／改派三選一）。
 * 計算明細、退回、更正與復核在 `/dashboard/admin/grading/<組別>`。
 * 暫存只有本人與管理員看得到：這一頁是管理員頁，所以列出暫存分數並標「未正式」。
 */

function versionLabel(v: SchemeVersionView, current: SchemeVersionView | null): string {
  if (v.isCurrent) return `${SCHEME_STATUS_LABEL[v.status]}・目前使用`
  if (v.status === 'draft') return '草稿'
  return current && v.versionNo < current.versionNo ? '已被新版本取代' : SCHEME_STATUS_LABEL[v.status]
}

function AssignmentLine({ a, editable }: { a: AdminAssignmentView; editable: boolean }) {
  const tone = a.state === 'counted' ? 'text-ink' : 'text-muted-foreground'
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 text-sm" data-testid="evaluator">
      <span className="font-medium text-ink">{a.teacherName}</span>
      {a.teacherInactive ? <span className="text-xs text-danger">帳號已停用，待管理員處理</span> : null}
      <span className={cn('text-xs', tone)}>
        {EVALUATION_STATE_LABEL[a.state]}
        {a.state === 'draft' ? `・${a.filled}／${a.total} 項` : ''}
      </span>
      {a.score !== null ? (
        <span className={cn('tabular-nums', a.state === 'counted' ? 'font-semibold text-ink' : 'text-muted-foreground')}>
          {a.score}
          {a.state === 'draft' ? '（未正式）' : ''}
        </span>
      ) : null}
      {editable ? (
        <Link
          href={`/dashboard/admin/grading/reassign/${a.id}`}
          className="text-xs font-medium text-primary underline-offset-2 hover:underline"
          aria-label={`移除或改派 ${a.teacherName} 老師`}
        >
          移除／改派
        </Link>
      ) : null}
    </li>
  )
}

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
  const actor = await requireRole('/dashboard/admin/grading', 'admin')

  const cohorts = (await getCohortStatusQuery().list()).filter((c) => c.status !== 'archived')
  const params = await searchParams
  const cohort = cohorts.find((c) => c.id === params.cohort) ?? cohorts.find((c) => c.isDefaultWorking) ?? cohorts[0] ?? null

  const shell = (children: React.ReactNode) => (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/grading">
      <PageHeader title="評分" description="評分方案、每組要幾份評分、指派哪位老師評；分數只有老師與系辦看得到，學生看不到。" />
      {children}
    </DashboardShell>
  )

  if (!cohort) {
    return shell(
      <EmptyState
        title="還沒有屆別"
        description="先到屆別頁新增一屆，才能設定那一屆的評分方案。"
        action={{ href: '/dashboard/admin/cohorts', label: '前往屆別' }}
      />,
    )
  }

  const [board, gradebook] = await Promise.all([
    getGradingQuery().adminBoard(actor, cohort.id),
    getGradebookQuery().gradebook(actor, cohort.id),
  ])
  if (!board.ok) return shell(<EmptyState title="讀不到評分資料" description={board.message} />)
  if (!gradebook.ok) return shell(<EmptyState title="讀不到成績" description={gradebook.message} />)
  // 成績表的篩選與匯出同一份（屆別＋階段＋組別＋完成狀態；伺服器重新算）。
  const filter = normalizeGradeExportFilter({ stage: params.fstage, group: params.fgroup, status: params.fstatus })
  const { current, versions, groups, requirements, assignments, teachers } = board.receipt
  const latest = versions[0] ?? null
  const locked = current?.status === 'locked'
  const stages = current?.stages ?? []
  const stage = stages.find((s) => s.key === params.stage) ?? stages[0] ?? null

  return shell(
    <>
      {cohorts.length > 1 ? (
        <nav aria-label="選擇屆別" className="mb-4 flex flex-wrap gap-2">
          {cohorts.map((c) => (
            <Link
              key={c.id}
              href={`/dashboard/admin/grading?cohort=${c.id}`}
              aria-current={c.id === cohort.id ? 'page' : undefined}
              className={cn(
                'rounded-full border px-3 py-1 text-sm',
                c.id === cohort.id ? 'border-primary bg-primary-subtle text-primary-on-subtle' : 'border-border text-ink hover:bg-muted',
              )}
            >
              {c.code}
            </Link>
          ))}
        </nav>
      ) : null}

      {current && params.applied === String(current.versionNo) ? (
        <p role="status" className="mb-4 rounded-md bg-primary-subtle px-3 py-2 text-sm text-primary-on-subtle">
          已套用方案 v{current.versionNo}：各組成績照新版本重算，新版本已鎖定。
        </p>
      ) : null}

      <section aria-label="評分方案" className="mb-6 space-y-4 rounded-card border border-border bg-background p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold text-primary">{cohort.code}・評分方案</p>
            <p data-testid="scheme-status" className="mt-0.5 text-xl font-semibold text-ink">
              {current ? `v${current.versionNo}・${SCHEME_STATUS_LABEL[current.status]}` : '還沒有發布的方案'}
            </p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {current
                ? locked
                  ? '已有老師正式送出評分，結構已鎖定；要改階段、項目、滿分或權重請建立新版本，先看影響再套用。'
                  : '還沒有老師正式送出評分：可以建立新版本並發布取代目前版本。第一份正式評分送出後就鎖定。'
                : '先建立方案並發布，才能設定要求份數與指派老師。'}
            </p>
          </div>
          <SchemeEditor
            cohortId={cohort.id}
            base={current?.stages ?? latest?.stages ?? []}
            baseLabel={current ? `v${current.versionNo}` : latest ? `v${latest.versionNo}` : null}
            requestId={randomUUID()}
            disabledReason={null}
          />
        </div>

        {current ? (
          <>
            <p data-testid="scheme-formula" className="text-sm text-ink">
              {describeFormula(current.stages)}
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              {current.stages.map((s) => (
                <div key={s.key} className="rounded-md border border-border p-4">
                  <p className="font-semibold text-ink">
                    {s.name} <span className="ml-1 text-xs font-normal text-muted-foreground">占總成績 {s.weight}%</span>
                  </p>
                  <ul className="mt-2 space-y-1 text-sm">
                    {s.items.map((i) => (
                      <li key={i.key} className="flex justify-between gap-2">
                        <span>{i.name}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {i.type === 'number' ? `滿分 ${i.max}・` : `${ITEM_TYPE_LABEL[i.type]}・`}
                          {i.type === 'passfail' ? '不計分' : `${i.weight}%`}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {s.letterMap ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      等第對照：{Object.entries(s.letterMap).map(([g, v]) => `${g}=${v}`).join('、')}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          </>
        ) : null}

        {versions.length > 0 ? (
          <div className="overflow-x-auto rounded-card border border-border">
            <table aria-label="方案版本" className="w-full min-w-[28rem] text-sm">
              <thead className="bg-muted text-left text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">版本</th>
                  <th className="px-4 py-2 font-medium">狀態</th>
                  <th className="px-4 py-2 font-medium">建立時間</th>
                  <th className="px-4 py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.id} className="border-t border-border">
                    <td className="px-4 py-2 font-semibold tabular-nums">v{v.versionNo}</td>
                    <td className="px-4 py-2">{versionLabel(v, current)}</td>
                    <td className="px-4 py-2 tabular-nums text-muted-foreground">{formatTaipeiMinute(v.createdAt)}</td>
                    <td className="px-4 py-2">
                      {v.status === 'draft' && locked ? (
                        <Link href={`/dashboard/admin/grading/apply/${v.id}`} className={LINK_BUTTON}>
                          看影響並套用 v{v.versionNo}
                        </Link>
                      ) : v.status === 'draft' ? (
                        <PublishButton versionId={v.id} versionNo={v.versionNo} requestId={randomUUID()} disabledReason={null} />
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <GradebookSection book={gradebook.receipt} filter={filter} />

      {current && stage ? (
        <Card title="評分要求與指派" description="每組每個階段要幾份評分（完成的分母），以及由哪幾位老師評。老師被指派後會收到通知。">
          <nav aria-label="選擇階段" className="mb-4 flex flex-wrap gap-2">
            {stages.map((s) => (
              <Link
                key={s.key}
                href={`/dashboard/admin/grading?cohort=${cohort.id}&stage=${s.key}`}
                aria-current={s.key === stage.key ? 'page' : undefined}
                className={cn(
                  'rounded-full border px-3 py-1 text-sm',
                  s.key === stage.key ? 'border-primary bg-primary-subtle text-primary-on-subtle' : 'border-border text-ink hover:bg-muted',
                )}
              >
                {s.name}
              </Link>
            ))}
          </nav>
          {groups.length === 0 ? (
            <EmptyState title="這一屆還沒有組別" description="組別成立後才能指派評分老師。" />
          ) : (
            <div className="overflow-x-auto rounded-card border border-border">
              <table aria-label={`${stage.name} 評分指派`} className="w-full min-w-[48rem] text-sm">
                <thead className="bg-muted text-left text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">組別</th>
                    <th className="px-4 py-2 font-medium">要求份數</th>
                    <th className="px-4 py-2 font-medium">評分老師與狀態</th>
                    <th className="px-4 py-2 font-medium">新增評分老師</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => {
                    const requirement = requirements.find((r) => r.groupId === g.id && r.stageKey === stage.key)
                    const mine = assignments.filter((a) => a.groupId === g.id && a.stageKey === stage.key)
                    // 份數的分子跟成績表同一份（採計中的正式評分，含改派時選「保留」「新增」後掛在已結束指派上的舊分）。
                    const stageResult = gradebook.receipt.groups
                      .find((x) => x.id === g.id)
                      ?.result.stages.find((s) => s.key === stage.key)
                    const counted = stageResult?.counted.length ?? mine.filter((a) => a.state === 'counted').length
                    const keptFromEnded = stageResult?.counted.filter((c) => c.assignmentEnded) ?? []
                    const assigned = new Set(mine.map((a) => a.teacherUserId))
                    return (
                      <tr key={g.id} className="border-t border-border align-top" data-testid={`grading-row-${g.code}`}>
                        <td className="px-4 py-3">
                          <p className="font-semibold text-ink">{g.code}</p>
                          <p className="text-xs text-muted-foreground">指導：{g.advisorName ?? '尚未指派'}</p>
                        </td>
                        <td className="px-4 py-3">
                          <RequirementForm
                            groupId={g.id}
                            groupCode={g.code}
                            stageKey={stage.key}
                            stageName={stage.name}
                            count={requirement?.requiredCount ?? null}
                            revision={requirement?.revision ?? 0}
                            requestId={randomUUID()}
                            max={MAX_REQUIRED_COUNT}
                          />
                          <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                            {requirement
                              ? `已正式送出 ${counted}／${requirement.requiredCount} 份`
                              : '未設定份數'}
                            {requirement && mine.length > requirement.requiredCount ? `・指派 ${mine.length} 位，多於要求` : ''}
                          </p>
                        </td>
                        <td className="px-4 py-3">
                          {mine.length > 0 ? (
                            <ul className="space-y-1">
                              {mine.map((a) => (
                                <AssignmentLine key={a.id} a={a} editable={!board.receipt.cohort.archived} />
                              ))}
                            </ul>
                          ) : (
                            <span className="text-sm text-muted-foreground">還沒有指派</span>
                          )}
                          {keptFromEnded.length > 0 ? (
                            <p className="mt-1 text-xs text-muted-foreground">
                              另有已改派、分數保留：{keptFromEnded.map((c) => `${c.teacherName} ${c.display}`).join('、')}
                            </p>
                          ) : null}
                        </td>
                        <td className="px-4 py-3">
                          <AssignEvaluatorForm
                            groupId={g.id}
                            groupCode={g.code}
                            stageKey={stage.key}
                            stageName={stage.name}
                            teachers={teachers.filter((t) => !assigned.has(t.userId))}
                            requestId={randomUUID()}
                          />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            移除或改派已正式送出的老師時，逐筆選舊分數怎麼算（保留／替換／新增），先看預覽再執行。
          </p>
        </Card>
      ) : null}
    </>,
  )
}

const LINK_BUTTON =
  'inline-flex items-center justify-center whitespace-nowrap rounded-md border border-border px-3 py-1.5 text-sm font-medium text-ink hover:bg-muted'

const STATUS_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'complete', label: '已完成' },
  { value: 'incomplete', label: '尚未完成' },
] as const

/**
 * 成績表（票 24；產品 06 §4「7.3」「7.4」、GRD-05／06／10）：各組各階段平均與最終（兩位小數）、完成狀態、
 * 更正註記、缺評待處理（老師停用）。篩選與匯出同一份；數字與匯出檔一致。
 */
function GradebookSection({ book, filter }: { book: Gradebook; filter: ReturnType<typeof normalizeGradeExportFilter> }) {
  const stages = book.version?.stages ?? []
  const shown = selectExportGroups(book, filter)
  const visibleStages = filter.stageKey === 'all' ? stages : stages.filter((s) => s.key === filter.stageKey)
  const base = `/dashboard/admin/grading?cohort=${book.cohort.id}`
  return (
    <>
      {book.pendingReviews.length > 0 ? (
        <section aria-label="待復核" className="mb-6 rounded-card border border-danger bg-danger-subtle/40 p-5">
          <h2 className="text-base font-semibold text-ink">待復核的更正（{book.pendingReviews.length}）</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            這些組別的採計分數、要求份數或方案改變了；原更正保留但暫不套用，請確認沿用或建立新的更正。
          </p>
          <ul className="mt-3 space-y-1 text-sm">
            {book.pendingReviews.map((p) => (
              <li key={p.overrideId} className="flex flex-wrap items-baseline gap-2">
                <Link href={`/dashboard/admin/grading/${p.groupId}`} className="font-semibold text-primary underline-offset-2 hover:underline">
                  {p.groupCode}
                </Link>
                <span className="tabular-nums text-muted-foreground">
                  原更正 {p.originalValue} → {p.newValue}（{p.reason}）
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Card
        title="成績表"
        description="各階段＝採計中正式評分的平均，份數沒到要求標「尚未完成」；最終＝各階段平均 × 占比，全部完成才算。顯示兩位小數（四捨五入），計算用完整精度。"
        className="mb-6"
      >
        {!book.version ? (
          <EmptyState title="還沒有評分方案" description="先建立並發布評分方案，成績表才會出現。" />
        ) : (
          <div className="space-y-4">
            <form method="get" action="/dashboard/admin/grading" aria-label="成績表篩選" className="flex flex-wrap items-end gap-3 text-sm">
              <input type="hidden" name="cohort" value={book.cohort.id} />
              <label className="space-y-1">
                <span className="block text-xs text-muted-foreground">階段</span>
                <select name="fstage" defaultValue={filter.stageKey} className="rounded-md border border-border bg-background px-2 py-1.5">
                  <option value="all">全部階段</option>
                  {stages.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="block text-xs text-muted-foreground">組別</span>
                <select name="fgroup" defaultValue={filter.groupId} className="rounded-md border border-border bg-background px-2 py-1.5">
                  <option value="all">全部組別</option>
                  {book.groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.code}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="block text-xs text-muted-foreground">完成狀態</span>
                <select name="fstatus" defaultValue={filter.status} className="rounded-md border border-border bg-background px-2 py-1.5">
                  {STATUS_FILTERS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className={LINK_BUTTON}>
                套用篩選
              </button>
              {filter.stageKey !== 'all' || filter.groupId !== 'all' || filter.status !== 'all' ? (
                <Link href={base} className="text-sm text-muted-foreground underline-offset-2 hover:underline">
                  清除
                </Link>
              ) : null}
            </form>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground tabular-nums" data-testid="gradebook-count">
                顯示 {shown.length}／{book.groups.length} 組
              </p>
              <GradeExportButtons
                cohortId={book.cohort.id}
                filter={{ stage: filter.stageKey, group: filter.groupId, status: filter.status }}
                disabled={shown.length === 0}
              />
            </div>
            {shown.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">沒有符合篩選的組別。</p>
            ) : (
              <div className="overflow-x-auto rounded-card border border-border">
                <table aria-label="成績表" className="w-full min-w-[40rem] text-sm">
                  <thead className="bg-muted text-left text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2 font-medium">組別</th>
                      {visibleStages.map((s) => (
                        <th key={s.key} className="px-4 py-2 text-right font-medium">
                          {s.name}（{s.weight}%）
                        </th>
                      ))}
                      <th className="px-4 py-2 text-right font-medium">最終成績</th>
                      <th className="px-4 py-2 font-medium">註記</th>
                      <th className="px-4 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((g) => {
                      const adopted = adoptedFinal(g.result, g.override)
                      const notes = [
                        describeOverride(g.override),
                        ...g.missing.filter((m) => m.teacherInactive).map(describeMissing),
                        ...unassignedSlots(g),
                      ].filter(Boolean)
                      return (
                        <tr key={g.id} className="border-t border-border align-top" data-testid={`gradebook-row-${g.code}`}>
                          <td className="px-4 py-3">
                            <p className="font-semibold text-ink">{g.code}</p>
                            <p className="text-xs text-muted-foreground">指導：{g.advisorName ?? '尚未指派'}</p>
                          </td>
                          {g.result.stages
                            .filter((s) => visibleStages.some((v) => v.key === s.key))
                            .map((s) => (
                              <td key={s.key} className="px-4 py-3 text-right" data-testid={`stage-${s.key}`}>
                                <p className={cn('tabular-nums', s.complete ? 'text-base font-semibold text-ink' : 'text-muted-foreground')}>
                                  {s.averageDisplay ?? '—'}
                                </p>
                                <p className={cn('text-xs', s.complete ? 'text-muted-foreground' : 'text-danger')}>{describeStageStatus(s)}</p>
                              </td>
                            ))}
                          <td className="px-4 py-3 text-right" data-testid="final">
                            <p className={cn('tabular-nums', adopted.value ? 'text-base font-extrabold text-ink' : 'text-sm text-muted-foreground')}>
                              {adopted.value ?? '尚未完成'}
                            </p>
                            {adopted.source === 'override' ? <p className="text-xs text-primary">已更正（原 {g.result.finalDisplay}）</p> : null}
                            {adopted.pendingReview ? <p className="text-xs text-danger">更正待復核</p> : null}
                          </td>
                          <td className="max-w-[18rem] px-4 py-3 text-xs">
                            {notes.length > 0 ? (
                              <ul className="space-y-0.5">
                                {notes.map((n) => (
                                  <li key={n} className={n.startsWith('已更正') ? 'text-muted-foreground' : 'text-danger'}>
                                    {n}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <Link href={`/dashboard/admin/grading/${g.id}`} className="text-sm font-medium text-primary underline-offset-2 hover:underline">
                              計算明細
                            </Link>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Card>
    </>
  )
}
