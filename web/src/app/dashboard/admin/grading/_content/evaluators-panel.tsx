import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { requireRole } from '@/app/_ui/guard'
import { PanelEmpty, QuietState } from '@/app/_ui/dashboard/primitives'
import { AssignEvaluatorForm, RequirementForm, ScrollToHighlight } from '@/app/dashboard/admin/grading/grading-forms'
import type { AdminAssignmentView, SchemeStage, StageSetting } from '@/application/grading'
import { cohortLabel } from '@/composition/cohorts'
import { EVALUATION_STATE_LABEL, getGradingSnapshotQuery, getGradingStageSettingQuery, MAX_REQUIRED_COUNT } from '@/composition/grading'
import { cn } from '@/shared/cn'

const GRADING = '/dashboard/admin/grading'
const BASE = `${GRADING}/teachers`

type Param = string | string[] | undefined
export type EvaluatorsSearchParams = { readonly group?: Param; readonly stage?: Param }

/** 卡片上的一列：一個評分項目，或同一評審組的幾個評分項目合成一列（§7.4）。 */
type Unit = { readonly keys: readonly string[]; readonly name: string; readonly panel: boolean }

/**
 * 把目前版本的評分項目排成列：同一個 `panelKey`、而且至少兩項都在目前版本裡的合成一列，其餘一項一列（照方案順序）。
 * 合成那一列的設定與指派都對第一項送出，伺服器同交易展開到評審組全部項目（C1-04 `appliedStageKeys`）。
 */
function unitsOf(stages: readonly SchemeStage[], settings: readonly StageSetting[]): Unit[] {
  const panelOf = new Map(settings.filter((s) => s.panelKey !== null).map((s) => [s.stageKey, s.panelKey!]))
  const members = new Map<string, SchemeStage[]>()
  for (const s of stages) {
    const key = panelOf.get(s.key)
    if (key) members.set(key, [...(members.get(key) ?? []), s])
  }
  const done = new Set<string>()
  const units: Unit[] = []
  for (const s of stages) {
    if (done.has(s.key)) continue
    const group = members.get(panelOf.get(s.key) ?? '') ?? []
    if (group.length >= 2) {
      for (const g of group) done.add(g.key)
      units.push({ keys: group.map((g) => g.key), name: group.map((g) => g.name).join('＋'), panel: true })
    } else {
      units.push({ keys: [s.key], name: s.name, panel: false })
    }
  }
  return units
}

const one = (v: Param) => (Array.isArray(v) ? v[0] : v)

/**
 * 「成績」的「評分老師」分頁內容（C 階段規格① §7.4、§11.2；原本 `grading/rules/page.tsx` 下半的「評分要求與指派」搬過來）。
 *
 * 每組一張卡；卡裡每個評分項目一列：要幾位老師評（0–10）、已正式送出幾份、評分老師（狀態、「移除／改派」）、「指派」。
 * 同一評審組的評分項目合成一列「系統驗收＋專題發表（同一組評審）」，設定與指派一次兩項同步（§1.3）。
 * 從成績表「尚缺 N 位評分老師」點進來帶 `?group=&stage=`：那一列高亮並捲到畫面中間（AC-30）。
 *
 * 讀取兩次：屆別評分快照（`board` 的組別、要幾位、指派、可指派的老師；`gradebook` 的採計份數與已改派但保留的分數，跟成績表同一份）、側表（評審組）。
 */
export async function EvaluatorsPanel({ cohortId, searchParams }: { cohortId: string; searchParams: EvaluatorsSearchParams }) {
  const actor = await requireRole(BASE, 'admin')
  const [snapshot, settings] = await Promise.all([
    getGradingSnapshotQuery().cohortSnapshot(actor, cohortId),
    getGradingStageSettingQuery().stageSettings(actor, cohortId),
  ])
  if (!snapshot.ok) return <QuietState title="讀不到評分資料" hint={snapshot.message} />
  const { board, gradebook } = snapshot.receipt
  const { current, groups, requirements, assignments, teachers } = board
  // 伺服器端的屆別狀態為準（寫入的用例本身也會以 COHORT_ARCHIVED 拒絕）。
  const archived = board.cohort.archived
  const stages = current?.stages ?? []
  const units = unitsOf(stages, settings.ok ? settings.receipt : [])
  const focusGroup = one(searchParams.group) ?? null
  const focusStage = one(searchParams.stage) ?? null
  const rowId = (groupId: string, unit: Unit) => `evaluators-${groupId}-${unit.keys[0]}`
  const focused = groups.find((g) => g.id === focusGroup)
  const focusedUnit = focused ? units.find((u) => focusStage !== null && u.keys.includes(focusStage)) : undefined

  return (
    <>
      {archived ? (
        <p role="status" data-testid="cohort-archived" className="rounded-lg bg-muted px-4 py-2.5 text-sm text-muted-foreground">
          {cohortLabel(board.cohort)}已封存，只能查看與匯出；要修改請先解封。
        </p>
      ) : null}

      <section aria-label="評分老師" className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground" data-testid="evaluators-intro">
          {current
            ? '每組每個評分項目要幾位老師評、指派哪位老師評；老師被指派後會收到通知。同一組評審的評分項目合成一列，指派一次兩項同步。'
            : '先發布評分規則，才能設定每組要幾位老師評、指派哪位老師評。'}
        </p>
        {!current ? (
          <Link href={`${GRADING}/rules?cohort=${cohortId}`} className="self-start text-sm font-semibold text-primary hover:underline">
            前往評分規則
          </Link>
        ) : groups.length === 0 ? (
          <PanelEmpty title="這一屆還沒有組別" />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {groups.map((g) => {
              const book = gradebook.groups.find((x) => x.id === g.id)
              return (
                <article
                  key={g.id}
                  id={`group-${g.id}`}
                  aria-label={g.code}
                  className={cn('dash-card flex min-w-0 flex-col gap-3 px-4 py-3', g.id === focusGroup && 'border-primary/60')}
                  data-testid={`grading-row-${g.code}`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="tabular font-bold text-foreground">{g.code}</p>
                    <p className="truncate text-xs text-muted-foreground">指導：{g.advisorName ?? '尚未指派'}</p>
                  </div>
                  {units.map((unit) => {
                    const primary = unit.keys[0]!
                    const requirement = requirements.find((r) => r.groupId === g.id && r.stageKey === primary)
                    const byKey = new Map(unit.keys.map((k) => [k, assignments.filter((a) => a.groupId === g.id && a.stageKey === k)]))
                    const results = new Map(unit.keys.map((k) => [k, book?.result.stages.find((s) => s.key === k)]))
                    const keptFromEnded = unit.keys.flatMap((k) => (results.get(k)?.counted ?? []).filter((c) => c.assignmentEnded))
                    // 已改派保留分數的老師也算已有評分：不能再被指派同一組同一評分項目。
                    const assigned = new Set([...unit.keys.flatMap((k) => byKey.get(k)!.map((a) => a.teacherUserId)), ...keptFromEnded.map((c) => c.teacherUserId)])
                    const highlight = g.id === focusGroup && focusStage !== null && unit.keys.includes(focusStage)
                    const label = `${g.code}「${unit.name}」`
                    const counted = (k: string) => results.get(k)?.counted.length ?? byKey.get(k)!.filter((a) => a.state === 'counted').length
                    const mine = byKey.get(primary)!
                    return (
                      <div
                        key={primary}
                        id={rowId(g.id, unit)}
                        role="group"
                        aria-label={label}
                        data-testid={`stage-row-${primary}`}
                        data-highlight={highlight ? 'true' : undefined}
                        className={cn('flex flex-col gap-2 rounded-lg border px-3 py-2.5', highlight ? 'border-primary bg-primary-subtle/40 ring-2 ring-primary' : 'border-border/70')}
                      >
                        <p className="text-sm font-semibold text-foreground">
                          {unit.name}
                          {unit.panel ? <span className="ml-1 text-xs font-normal text-muted-foreground">（同一組評審）</span> : null}
                        </p>
                        <div>
                          {archived ? null : (
                            <RequirementForm
                              groupId={g.id}
                              groupCode={g.code}
                              stageKey={primary}
                              stageName={unit.name}
                              count={requirement?.requiredCount ?? null}
                              revision={requirement?.revision ?? 0}
                              requestId={randomUUID()}
                              max={MAX_REQUIRED_COUNT}
                            />
                          )}
                          <p className="mt-1 text-xs tabular-nums text-muted-foreground" data-testid="counted">
                            {!requirement
                              ? '還沒設定要幾位老師評'
                              : unit.panel
                                ? unit.keys
                                    .map((k) => `${stages.find((s) => s.key === k)?.name ?? k} 已正式送出 ${counted(k)}／${requirement.requiredCount} 份`)
                                    .join('・')
                                : `已正式送出 ${counted(primary)}／${requirement.requiredCount} 份`}
                            {requirement && mine.length > requirement.requiredCount ? `・指派 ${mine.length} 位，多於要的人數` : ''}
                          </p>
                        </div>
                        {unit.keys.some((k) => byKey.get(k)!.length > 0) ? (
                          <ul className="flex flex-col gap-1.5">
                            {unit.panel ? (
                              <PanelAssignments unit={unit} stages={stages} byKey={byKey} editable={!archived} />
                            ) : (
                              mine.map((a) => <AssignmentLine key={a.id} a={a} editable={!archived} />)
                            )}
                          </ul>
                        ) : (
                          <p className="text-sm text-muted-foreground">還沒有指派</p>
                        )}
                        {keptFromEnded.length > 0 ? (
                          <p className="text-xs text-muted-foreground">
                            另有已改派、分數保留：{keptFromEnded.map((c) => `${c.teacherName} ${c.display}`).join('、')}
                          </p>
                        ) : null}
                        {archived ? (
                          <span className="text-xs text-muted-foreground">已封存，不能指派</span>
                        ) : (
                          <AssignEvaluatorForm
                            groupId={g.id}
                            groupCode={g.code}
                            stageKey={primary}
                            stageName={unit.name}
                            teachers={teachers.filter((t) => !assigned.has(t.userId))}
                            requestId={randomUUID()}
                          />
                        )}
                      </div>
                    )
                  })}
                </article>
              )
            })}
          </div>
        )}
      </section>
      {focused && focusedUnit ? <ScrollToHighlight targetId={rowId(focused.id, focusedUnit)} /> : null}
    </>
  )
}

/** 一位評分老師（單一評分項目）：姓名、狀態、分數、「移除／改派」。 */
function AssignmentLine({ a, editable }: { a: AdminAssignmentView; editable: boolean }) {
  const tone = a.state === 'counted' ? 'text-foreground' : 'text-muted-foreground'
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 rounded-lg bg-muted/60 px-2.5 py-1.5 text-sm" data-testid="evaluator">
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
      {editable ? <ReassignLink id={a.id} name={a.teacherName} /> : null}
    </li>
  )
}

/** 同一評審組那一列的評分老師：一位老師一行，各評分項目的狀態並排（分數各項目一份）；「移除／改派」一次動整組。 */
function PanelAssignments({
  unit,
  stages,
  byKey,
  editable,
}: {
  unit: Unit
  stages: readonly SchemeStage[]
  byKey: ReadonlyMap<string, readonly AdminAssignmentView[]>
  editable: boolean
}) {
  const teachers = new Map<string, { name: string; inactive: boolean; first: AdminAssignmentView; byStage: Map<string, AdminAssignmentView> }>()
  for (const k of unit.keys) {
    for (const a of byKey.get(k) ?? []) {
      const t = teachers.get(a.teacherUserId) ?? { name: a.teacherName, inactive: a.teacherInactive, first: a, byStage: new Map() }
      t.byStage.set(k, a)
      teachers.set(a.teacherUserId, t)
    }
  }
  return (
    <>
      {[...teachers.entries()].map(([userId, t]) => (
        <li key={userId} className="flex flex-wrap items-baseline gap-x-2 rounded-lg bg-muted/60 px-2.5 py-1.5 text-sm" data-testid="evaluator">
          <span className="font-medium text-foreground">{t.name}</span>
          {t.inactive ? <span className="text-xs text-destructive">帳號已停用，待管理員處理</span> : null}
          {unit.keys.map((k) => {
            const a = t.byStage.get(k)
            const name = stages.find((s) => s.key === k)?.name ?? k
            return (
              <span key={k} className="text-xs text-muted-foreground">
                {name}：{a ? `${EVALUATION_STATE_LABEL[a.state]}${a.score !== null ? ` ${a.score}${a.state === 'draft' ? '（未正式）' : ''}` : ''}` : '沒有指派'}
              </span>
            )
          })}
          {editable ? <ReassignLink id={t.first.id} name={t.name} /> : null}
        </li>
      ))}
    </>
  )
}

function ReassignLink({ id, name }: { id: string; name: string }) {
  return (
    <Link
      href={`${GRADING}/reassign/${id}`}
      className="ml-auto inline-flex min-h-9 items-center text-xs font-medium text-primary underline-offset-2 hover:underline"
      aria-label={`移除或改派 ${name} 老師`}
    >
      移除／改派
    </Link>
  )
}
