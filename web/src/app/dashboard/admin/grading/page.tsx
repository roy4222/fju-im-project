import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { IconAlertTriangle, IconChecklist, IconHistory, IconScale, IconUserCheck, IconUsers } from '@tabler/icons-react'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { Bars, HBar, StackedRows } from '@/app/_ui/dashboard/charts'
import { ClearFilters, DataTableFrame, DataTableToolbar, DT, EmptyRow } from '@/app/_ui/data-table'
import { FacetMenu } from '@/app/_ui/data-table-facet'
import { SectionDialog } from '@/app/_ui/dashboard/section-dialog'
import { BTN_ROW_GHOST } from '@/app/_ui/dashboard/look'
import { buttonVariants } from '@/app/_ui/ui/button'
import { CohortPills, PageTitle, Panel, PANEL_TABLE_HEAD, PanelEmpty, Pill, QuietState } from '@/app/_ui/dashboard/primitives'
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

export const metadata = { title: '成績管理｜資管系專題平台' }

const BASE = '/dashboard/admin/grading'

/**
 * 管理員「成績管理」（票 23、24；原型 `/dashboard/admin/grading`）。
 *
 * 外觀照原型（票 36，Roy 選的畫布 A「圖在上、表在下、方案最後」）：標題列（方案版本、階段權重、右上建立新方案版本）→
 * 各階段完成率＋老師評分進度兩張圖 → 待復核的更正 → 成績表（票 24：各組各階段平均、最終、完成狀態、篩選與匯出）→
 * 評分方案（目前版本、公式）。原型主畫面只有圖、成績表與方案，設定放在對話框裡（「建立新方案版本」的第 3 段
 * 是評審分配），所以「評分要求與指派」收進標題右側的對話框、版本清單收進評分方案標題列的「版本紀錄」對話框。
 * 兩張圖的數字都從同一份 board／gradebook 算，不另外查。
 * 計算明細、退回、更正與復核在 `/dashboard/admin/grading/<組別>`。
 * 暫存只有本人與管理員看得到：這一頁是管理員頁，所以列出暫存分數並標「未正式」。
 */

function versionLabel(v: SchemeVersionView, current: SchemeVersionView | null): string {
  if (v.isCurrent) return `${SCHEME_STATUS_LABEL[v.status]}・目前使用`
  if (v.status === 'draft') return '草稿'
  return current && v.versionNo < current.versionNo ? '已被新版本取代' : SCHEME_STATUS_LABEL[v.status]
}

function AssignmentLine({ a, editable }: { a: AdminAssignmentView; editable: boolean }) {
  const tone = a.state === 'counted' ? 'text-foreground' : 'text-muted-foreground'
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 text-sm" data-testid="evaluator">
      <span className="font-medium text-foreground">{a.teacherName}</span>
      {a.teacherInactive ? <span className="text-xs text-destructive">帳號已停用，待管理員處理</span> : null}
      <span className={cn('text-xs', tone)}>
        {EVALUATION_STATE_LABEL[a.state]}
        {a.state === 'draft' ? `・${a.filled}／${a.total} 項` : ''}
      </span>
      {a.score !== null ? (
        <span className={cn('tabular-nums', a.state === 'counted' ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
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
    dialog?: string | string[]
  }>
}) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole(BASE, 'admin')

  // 封存的屆別也可選（產品模組 02 §11.3「封存後…管理員可查與匯出」）：只能看與匯出，寫入的控制都停用。
  const cohorts = await getCohortStatusQuery().list()
  const params = await searchParams
  const cohort =
    cohorts.find((c) => c.id === params.cohort) ??
    cohorts.find((c) => c.isDefaultWorking) ??
    cohorts.find((c) => c.status !== 'archived') ??
    cohorts[0] ??
    null

  const shell = (children: React.ReactNode, title?: { description: React.ReactNode; actions?: React.ReactNode }) => (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current={BASE}>
      <div className="flex flex-col gap-5">
        <PageTitle
          title="成績管理"
          description={title?.description ?? '評分方案、每組要幾份評分、指派哪位老師評；分數只有老師與系辦看得到，學生看不到。'}
          actions={title?.actions}
        />
        {children}
      </div>
    </DashboardShell>
  )

  if (!cohort) {
    return shell(
      <QuietState
        title="還沒有屆別"
        hint="先到屆別頁新增一屆，才能設定那一屆的評分方案。"
        action={
          <Link href="/dashboard/admin/cohorts" className="text-sm font-semibold text-primary hover:underline">
            前往屆別
          </Link>
        }
      />,
    )
  }

  const [board, gradebook] = await Promise.all([
    getGradingQuery().adminBoard(actor, cohort.id),
    getGradebookQuery().gradebook(actor, cohort.id),
  ])
  if (!board.ok) return shell(<QuietState title="讀不到評分資料" hint={board.message} />)
  if (!gradebook.ok) return shell(<QuietState title="讀不到成績" hint={gradebook.message} />)
  // 成績表的篩選與匯出同一份（屆別＋階段＋組別＋完成狀態；伺服器重新算）。
  const filter = normalizeGradeExportFilter({ stage: params.fstage, group: params.fgroup, status: params.fstatus })
  const { current, versions, groups, requirements, assignments, teachers } = board.receipt
  // 伺服器端的屆別狀態為準（寫入的用例本身也會以 COHORT_ARCHIVED 拒絕）。
  const archived = board.receipt.cohort.archived
  const archivedReason = archived ? `${board.receipt.cohort.code} 已封存，只能查看與匯出；要修改請先解封。` : null
  const latest = versions[0] ?? null
  const locked = current?.status === 'locked'
  const stages = current?.stages ?? []
  const stage = stages.find((s) => s.key === params.stage) ?? stages[0] ?? null
  // 對話框的深連結（`?dialog=assign`、`?dialog=versions`）：換階段、發布後回來時保持打開。
  const dialogParam = Array.isArray(params.dialog) ? params.dialog[0] : params.dialog

  // 原型「各階段完成率」：每階段已正式送出（採計中）的份數／要求份數，從成績表同一份資料算。
  const stageRows = stages.map((s) => {
    let done = 0
    let total = 0
    for (const g of gradebook.receipt.groups) {
      // 解散的組評分已停止，不算進完成率。
      if (g.dissolved) continue
      const r = g.result.stages.find((x) => x.key === s.key)
      if (!r || r.required === null) continue
      total += r.required
      done += Math.min(r.counted.length, r.required)
    }
    return { key: s.key, label: `${s.name}（${s.weight}%）`, done, total }
  })
  // 原型「老師評分進度」：目前選的階段，每位老師被指派的份數與已正式送出的份數。
  // 只算進行中的組（`groups` 只有進行中的組）：解散的組評分已停止，沒結束的指派也不算缺評。
  const activeGroupIds = new Set(groups.map((g) => g.id))
  const stageAssignments = stage ? assignments.filter((a) => a.stageKey === stage.key && activeGroupIds.has(a.groupId)) : []
  const byTeacher = new Map<string, { name: string; assigned: number; counted: number }>()
  for (const a of stageAssignments) {
    const t = byTeacher.get(a.teacherUserId) ?? { name: a.teacherName, assigned: 0, counted: 0 }
    t.assigned += 1
    if (a.state === 'counted') t.counted += 1
    byTeacher.set(a.teacherUserId, t)
  }
  const teacherProgress = [...byTeacher.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
  const countedInStage = teacherProgress.reduce((n, t) => n + t.counted, 0)
  const assignedInStage = teacherProgress.reduce((n, t) => n + t.assigned, 0)
  const missing = teacherProgress.filter((t) => t.counted < t.assigned).length

  const description = current ? (
    <>
      方案 v{current.versionNo}・{current.stages.map((s) => `${s.name} ${s.weight}%`).join(' ＋ ')}・{SCHEME_STATUS_LABEL[current.status]}。
      {stage ? `現在看「${stage.name}」。` : ''}評分方案、每組要幾份評分、指派哪位老師評；分數只有老師與系辦看得到。
    </>
  ) : (
    '還沒有發布的評分方案：先建立方案並發布，才能設定每組要幾份評分、指派哪位老師評。分數只有老師與系辦看得到。'
  )

  return shell(
    <>
      <CohortPills
        cohorts={cohorts.map((c) => ({ id: c.id, code: c.status === 'archived' ? `${c.code}・已封存` : c.code }))}
        currentId={cohort.id}
        hrefFor={(id) => `${BASE}?cohort=${id}`}
      />
      {archivedReason ? (
        <p role="status" data-testid="cohort-archived" className="rounded-lg bg-muted px-4 py-2.5 text-sm text-muted-foreground">
          {archivedReason}
        </p>
      ) : null}

      {current && params.applied === String(current.versionNo) ? (
        <p role="status" className="rounded-lg bg-brand-subtle px-4 py-2.5 text-sm text-brand-on-subtle">
          已套用方案 v{current.versionNo}：各組成績照新版本重算，新版本已鎖定。
        </p>
      ) : null}

      {current ? (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Panel title="各階段完成率" icon={<IconChecklist />} description="已正式送出評分份數／要求份數">
            <div className="px-5 pb-5">
              {stageRows.some((r) => r.total > 0) ? (
                <StackedRows rows={stageRows} />
              ) : (
                <p className="py-6 text-center text-sm text-muted-foreground">還沒有設定任何一組的要求份數。</p>
              )}
            </div>
          </Panel>
          <Panel
            title="老師評分進度"
            icon={<IconUsers />}
            description={stage ? `${stage.name}・${countedInStage}／${assignedInStage} 份${missing ? `・${missing} 位未送齊` : ''}` : undefined}
          >
            <div className="px-3 pb-3">
              {teacherProgress.length > 0 ? (
                <Bars height={150} data={teacherProgress.map((t) => ({ label: t.name, value: t.counted, hot: t.counted === t.assigned }))} />
              ) : (
                <p className="px-2 py-6 text-center text-sm text-muted-foreground">這個階段還沒有指派評分老師。</p>
              )}
            </div>
          </Panel>
        </div>
      ) : null}

      <GradebookSection book={gradebook.receipt} filter={filter} />

      <Panel
        title={
          <>
            評分方案 <span data-testid="scheme-status">{current ? `v${current.versionNo}・${SCHEME_STATUS_LABEL[current.status]}` : '還沒有發布的方案'}</span>
          </>
        }
        icon={<IconScale />}
        description={current ? (locked ? '已鎖定，改結構請建立新方案版本' : '還沒有老師開始評分，可以發布新版本取代') : undefined}
        aria-label="評分方案"
        action={
          versions.length > 0 ? (
            <SectionDialog
              label={`版本紀錄（${versions.length}）`}
              icon={<IconHistory aria-hidden />}
              title="評分方案版本"
              description="每一版的狀態與建立時間；草稿在這裡發布，方案鎖定後的新版本要先看影響再套用。"
              openParam="versions"
              defaultOpen={dialogParam === 'versions'}
              size="xl"
              triggerClassName={BTN_ROW_GHOST}
            >
          <div className="overflow-x-auto">
            <table aria-label="方案版本" className="w-full min-w-[28rem] text-sm">
              <thead>
                <tr className={PANEL_TABLE_HEAD}>
                  <th className="px-5 py-2.5 font-semibold">版本</th>
                  <th className="px-4 py-2.5 font-semibold">狀態</th>
                  <th className="px-4 py-2.5 font-semibold">建立時間</th>
                  <th className="px-5 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.id} className="border-t border-border/70">
                    <td className="tabular px-5 py-2.5 font-semibold">v{v.versionNo}</td>
                    <td className="px-4 py-2.5">
                      <Pill tone={v.isCurrent ? 'brand' : 'default'}>{versionLabel(v, current)}</Pill>
                    </td>
                    <td className="tabular px-4 py-2.5 text-muted-foreground">{formatTaipeiMinute(v.createdAt)}</td>
                    <td className="px-5 py-2.5 text-right">
                      {v.status === 'draft' && archived ? null : v.status === 'draft' && locked ? (
                        <Link href={`${BASE}/apply/${v.id}`} className={LINK_BUTTON}>
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
            </SectionDialog>
          ) : null
        }
      >
        {current ? (
          <>
            <div className="grid gap-x-8 border-t border-border/70 md:grid-cols-2">
              {current.stages.map((s) => {
                const sum = s.items.filter((i) => i.type !== 'passfail').reduce((a, i) => a + i.weight, 0)
                return (
                  <div key={s.key} className="px-5 py-4">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-bold">
                        {s.name} <span className="ml-1 text-xs font-normal text-muted-foreground">占總成績 {s.weight}%</span>
                      </p>
                      <Pill tone={sum === 100 ? 'success' : 'danger'}>項目 {sum}%</Pill>
                    </div>
                    <ul className="mt-3 flex flex-col gap-2">
                      {s.items.map((i) => (
                        <li key={i.key}>
                          <HBar
                            label={i.name}
                            value={i.type === 'passfail' ? 0 : i.weight}
                            total={100}
                            suffix={i.type === 'number' ? `${i.weight}%・滿分 ${i.max}` : i.type === 'passfail' ? `${ITEM_TYPE_LABEL[i.type]}・不計分` : `${i.weight}%・${ITEM_TYPE_LABEL[i.type]}`}
                          />
                        </li>
                      ))}
                    </ul>
                    {s.letterMap ? (
                      <p className="mt-2 text-xs text-muted-foreground">
                        等第對照：{Object.entries(s.letterMap).map(([g, v]) => `${g}=${v}`).join('、')}
                      </p>
                    ) : null}
                  </div>
                )
              })}
            </div>
            <p data-testid="scheme-formula" className="border-t border-border/70 px-5 py-3 text-xs text-muted-foreground">
              {describeFormula(current.stages)}
            </p>
          </>
        ) : (
          <PanelEmpty title="還沒有發布的方案" hint="按右上「建立新方案版本」設定階段、項目、滿分與權重，再發布。" />
        )}

        <p className="border-t border-border/70 px-5 py-3 text-xs text-muted-foreground">
          {current
            ? locked
              ? '已有老師開始評分（暫存或正式送出），結構已鎖定；要改階段、項目、滿分或權重請建立新版本，先看影響再套用。'
              : '第一位老師暫存或送出評分後就鎖定。'
            : '最終成績＝Σ（階段成績 × 階段權重）；階段成績為採計中正式評分的平均。'}
        </p>
      </Panel>

    </>,
    {
      description,
      actions: (
        <>
          {current && stage ? (
            <SectionDialog
              label="評分要求與指派"
              icon={<IconUserCheck aria-hidden />}
              title="評分要求與指派"
              description="每組每個階段要幾份評分、由哪幾位老師評；老師被指派後會收到通知。"
              openParam="assign"
              defaultOpen={dialogParam === 'assign'}
              size="wide"
              triggerClassName={buttonVariants({ variant: 'outline', size: 'lg', className: 'press h-10 rounded-lg px-4' })}
            >
          <nav aria-label="選擇階段" className="flex flex-wrap items-center gap-1 border-b border-border px-3">
            {stages.map((s) => {
              const on = s.key === stage.key
              return (
                <Link
                  key={s.key}
                  href={`${BASE}?cohort=${cohort.id}&stage=${s.key}&dialog=assign`}
                  aria-current={on ? 'page' : undefined}
                  className={cn(
                    'relative inline-flex h-10 items-center px-3 text-sm font-semibold transition-colors',
                    on ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {s.name}
                  <span
                    aria-hidden
                    className={cn('absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-brand transition-transform', on ? 'scale-x-100' : 'scale-x-0')}
                  />
                </Link>
              )
            })}
          </nav>
          {groups.length === 0 ? (
            <PanelEmpty title="這一屆還沒有組別" hint="組別成立後才能指派評分老師。" />
          ) : (
            <div className="overflow-x-auto">
              <table aria-label={`${stage.name} 評分指派`} className="w-full min-w-[48rem] text-sm">
                <thead>
                  <tr className={PANEL_TABLE_HEAD}>
                    <th className="px-5 py-2.5 font-semibold">組別</th>
                    <th className="px-4 py-2.5 font-semibold">要求份數</th>
                    <th className="px-4 py-2.5 font-semibold">評分老師與狀態</th>
                    <th className="px-5 py-2.5 font-semibold">新增評分老師</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => {
                    const requirement = requirements.find((r) => r.groupId === g.id && r.stageKey === stage.key)
                    const mine = assignments.filter((a) => a.groupId === g.id && a.stageKey === stage.key)
                    const stageResult = gradebook.receipt.groups
                      .find((x) => x.id === g.id)
                      ?.result.stages.find((s) => s.key === stage.key)
                    // 採計份數與成績表同一份（含已改派但保留的舊分數）。
                    const counted = stageResult?.counted.length ?? mine.filter((a) => a.state === 'counted').length
                    const keptFromEnded = stageResult?.counted.filter((c) => c.assignmentEnded) ?? []
                    // 已改派保留分數的老師也算已有評分：不能再被指派同一組同一階段。
                    const assigned = new Set([...mine.map((a) => a.teacherUserId), ...keptFromEnded.map((c) => c.teacherUserId)])
                    return (
                      <tr key={g.id} className="border-t border-border/70 align-top" data-testid={`grading-row-${g.code}`}>
                        <td className="px-5 py-3">
                          <p className="tabular font-bold text-foreground">{g.code}</p>
                          <p className="text-xs text-muted-foreground">指導：{g.advisorName ?? '尚未指派'}</p>
                        </td>
                        <td className="px-4 py-3">
                          {archived ? null : (
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
                          )}
                          <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                            {requirement ? `已正式送出 ${counted}／${requirement.requiredCount} 份` : '未設定份數'}
                            {requirement && mine.length > requirement.requiredCount ? `・指派 ${mine.length} 位，多於要求` : ''}
                          </p>
                        </td>
                        <td className="px-4 py-3">
                          {mine.length > 0 ? (
                            <ul className="space-y-1">
                              {mine.map((a) => (
                                <AssignmentLine key={a.id} a={a} editable={!archived} />
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
                        <td className="px-5 py-3">
                          {archived ? (
                            <span className="text-xs text-muted-foreground">已封存，不能指派</span>
                          ) : (
                            <AssignEvaluatorForm
                              groupId={g.id}
                              groupCode={g.code}
                              stageKey={stage.key}
                              stageName={stage.name}
                              teachers={teachers.filter((t) => !assigned.has(t.userId))}
                              requestId={randomUUID()}
                            />
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="border-t border-border/70 px-5 py-3 text-xs text-muted-foreground">
            移除或改派已正式送出的老師時，逐筆選舊分數怎麼算（保留／替換／新增），先看預覽再執行。
          </p>
            </SectionDialog>
          ) : null}
          <SchemeEditor
          cohortId={cohort.id}
          base={current?.stages ?? latest?.stages ?? []}
          baseLabel={current ? `v${current.versionNo}` : latest ? `v${latest.versionNo}` : null}
          requestId={randomUUID()}
          disabledReason={archivedReason}
          />
        </>
      ),
    },
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
 * 外觀照原型「各組階段成績」：Panel 裡一張表，階段分數大字、狀態用標籤。
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
      {book.pendingReviews.length > 0 ? (
        <Panel
          title={`待復核的更正（${book.pendingReviews.length}）`}
          icon={<IconAlertTriangle />}
          description="採計分數、要求份數或方案改變了；原更正保留但暫不套用"
          aria-label="待復核"
          className="border-destructive/40"
        >
          <ul className="space-y-1 border-t border-border/70 px-5 py-3 text-sm">
            {book.pendingReviews.map((p) => (
              <li key={p.overrideId} className="flex flex-wrap items-baseline gap-2">
                <Link href={`${BASE}/${p.groupId}`} className="font-semibold text-primary underline-offset-2 hover:underline">
                  {p.groupCode}
                </Link>
                <span className="tabular-nums text-muted-foreground">
                  原更正 {p.originalValue} → {p.newValue}（{p.reason}）
                </span>
              </li>
            ))}
          </ul>
          <p className="border-t border-border/70 px-5 py-3 text-xs text-muted-foreground">請到該組的計算明細確認沿用或建立新的更正。</p>
        </Panel>
      ) : null}

      <Panel
        title="各組成績"
        icon={<IconChecklist />}
        description="階段達到要求份數才有階段平均；更正與退回都留紀錄"
        aria-label="成績表"
        bodyClassName="p-4"
      >
        {!book.version ? (
          <PanelEmpty title="還沒有評分方案" hint="先建立並發布評分方案，成績表才會出現。" />
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
              <table aria-label="成績表" className={`${DT.table} min-w-[44rem]`}>
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
                                <Pill tone="default">已解散・唯讀{g.versionNo !== null && g.versionNo !== book.version?.versionNo ? `・方案 v${g.versionNo}` : ''}</Pill>
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
                                    v{g.versionNo}：{s.name} {s.weight}%
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
                            {adopted.pendingReview ? <p className="text-xs text-destructive">更正待復核</p> : null}
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
    </>
  )
}
