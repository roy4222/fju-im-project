import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { HBar } from '@/app/_ui/dashboard/charts'
import { CohortPills, PageTitle, Panel, PanelEmpty, Pill, QuietState } from '@/app/_ui/dashboard/primitives'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { AssignEvaluatorForm, PublishButton, RequirementForm, SchemeEditor } from '@/app/dashboard/admin/grading/grading-forms'
import type { AdminAssignmentView, SchemeVersionView } from '@/application/grading'
import { cohortLabel, getCohortStatusQuery } from '@/composition/cohorts'
import {
  describeFormula,
  EVALUATION_STATE_LABEL,
  getGradebookQuery,
  getGradingQuery,
  ITEM_TYPE_LABEL,
  MAX_REQUIRED_COUNT,
  SCHEME_STATUS_LABEL,
} from '@/composition/grading'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute } from '@/shared/time'

export const metadata = { title: '評分規則｜資管系專題平台' }

const GRADING = '/dashboard/admin/grading'
const BASE = `${GRADING}/rules`

/**
 * 系辦「評分規則」子頁（AD-08；設計方案 §3.4）：一年用一兩次的設定，從成績頁搬出來。
 * 不是分頁，所以沒有分頁列（AC-AD-29），只有「← 回成績」。三個區塊：
 *
 * 1. 目前版本：`scheme-status`、建立新版評分規則（成功訊息在區塊內，不在標題列）、階段與項目權重、公式。
 * 2. 版本紀錄：每版一張卡；草稿卡有「發布第 N 版」，評分規則鎖定後的草稿卡改成「查看第 N 版重算影響（尚不套用）」→ `apply/<版本>`。
 *    已發布的版本不放套用連結：套用頁只收草稿（`previewSchemeVersion`），連過去只會看到「不能套用」。
 * 3. 評分要求與指派：選階段，每組一張卡（需要幾位老師評分、評分老師與「移除／改派」、指派）。
 *
 * 讀取三次：屆別、`adminBoard`（版本、要求、指派、可指派的老師）、`gradebook`（採計份數與已改派但保留的分數，和成績表同一份）。
 * 守衛在頁面自己（`_nav.ts` 的 `PROTECTED_ROUTES` 有這一列，pages.spec 逐條驗三種回應）。
 */

function versionLabel(v: SchemeVersionView, current: SchemeVersionView | null): string {
  if (v.isCurrent) return `${SCHEME_STATUS_LABEL[v.status]}・目前使用`
  if (v.status === 'draft') return '草稿'
  return current && v.versionNo < current.versionNo ? '已被新版本取代' : SCHEME_STATUS_LABEL[v.status]
}

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
      {editable ? (
        <Link
          href={`${GRADING}/reassign/${a.id}`}
          className="ml-auto text-xs font-medium text-primary underline-offset-2 hover:underline"
          aria-label={`移除或改派 ${a.teacherName} 老師`}
        >
          移除／改派
        </Link>
      ) : null}
    </li>
  )
}

export default async function AdminGradingRulesPage({
  searchParams,
}: {
  searchParams: Promise<{ cohort?: string | string[]; stage?: string | string[] }>
}) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole(BASE, 'admin')

  const cohorts = await getCohortStatusQuery().list()
  const params = await searchParams
  const cohort =
    cohorts.find((c) => c.id === params.cohort) ??
    cohorts.find((c) => c.isDefaultWorking) ??
    cohorts.find((c) => c.status !== 'archived') ??
    cohorts[0] ??
    null

  const shell = (children: React.ReactNode) => (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current={GRADING}>
      <div className="flex flex-col gap-5">
        <div>
          <Link
            href={cohort ? `${GRADING}?cohort=${cohort.id}` : GRADING}
            className="mb-3 inline-flex text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            ← 回成績
          </Link>
          <PageTitle title="評分規則" />
        </div>
        {/* 屆別膠囊獨立一列：測試站屆別多，放標題列右邊會把標題擠成直排（網站問題 #8）。 */}
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
        hint="先新增一屆，才能設定每組要幾份評分、指派哪位老師評。"
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
  const { current, versions, groups, requirements, assignments, teachers } = board.receipt
  // 伺服器端的屆別狀態為準（寫入的用例本身也會以 COHORT_ARCHIVED 拒絕）。
  const archived = board.receipt.cohort.archived
  const archivedReason = archived ? `${cohortLabel(board.receipt.cohort)}已封存，只能查看與匯出；要修改請先解封。` : null
  const latest = versions[0] ?? null
  const locked = current?.status === 'locked'
  const stages = current?.stages ?? []
  const stage = stages.find((s) => s.key === params.stage) ?? stages[0] ?? null

  return shell(
    <>
      {archivedReason ? (
        <p role="status" data-testid="cohort-archived" className="rounded-lg bg-muted px-4 py-2.5 text-sm text-muted-foreground">
          {archivedReason}
        </p>
      ) : null}

      <Panel
        title={
          <>
            目前版本{' '}
            <span data-testid="scheme-status" className="ml-1 font-semibold text-muted-foreground">
              {current ? `第 ${current.versionNo} 版・${SCHEME_STATUS_LABEL[current.status]}` : '還沒有發布的評分規則'}
            </span>
          </>
        }
        aria-label="目前版本"
      >
        <div className="flex flex-col gap-1 border-t border-border/70 px-5 py-4">
          <SchemeEditor
            cohortId={cohort.id}
            base={current?.stages ?? latest?.stages ?? []}
            baseLabel={current ? `第 ${current.versionNo} 版` : latest ? `第 ${latest.versionNo} 版` : null}
            requestId={randomUUID()}
            disabledReason={archivedReason}
            locked={locked}
          />
          {locked && !archived ? <p className="text-xs text-muted-foreground">已有老師開始評分，這一版不能改；要改請建立新版。</p> : null}
        </div>
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
        ) : null}
      </Panel>

      <section aria-label="版本紀錄" className="flex flex-col gap-3">
        <h2 className="text-[15px] font-bold text-foreground">版本紀錄（{versions.length}）</h2>
        {versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">還沒有任何版本。</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {versions.map((v) => (
              <article
                key={v.id}
                id={`version-${v.versionNo}`}
                aria-label={`第 ${v.versionNo} 版`}
                className={cn('dash-card flex flex-col gap-2 px-4 py-3', v.isCurrent && 'border-primary/50')}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="tabular font-bold text-foreground">第 {v.versionNo} 版</p>
                  <Pill tone={v.isCurrent ? 'brand' : 'default'}>{versionLabel(v, current)}</Pill>
                </div>
                <p className="tabular text-xs text-muted-foreground">建立於 {formatTaipeiMinute(v.createdAt)}</p>
                {v.status === 'draft' && archived ? null : v.status === 'draft' && locked ? (
                  <Link href={`${GRADING}/apply/${v.id}`} className={LINK_BUTTON}>
                    查看第 {v.versionNo} 版重算影響（尚不套用）
                  </Link>
                ) : v.status === 'draft' ? (
                  <PublishButton versionId={v.id} versionNo={v.versionNo} requestId={randomUUID()} disabledReason={null} />
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>

      <section aria-label="評分要求與指派" className="flex flex-col gap-3">
        <div>
          <h2 className="text-[15px] font-bold text-foreground">評分要求與指派</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {current ? '每組要幾份評分、指派哪位老師評；老師被指派後會收到通知。' : '先發布評分規則，才能設定每組要幾份評分、指派哪位老師評。'}
          </p>
        </div>
        {current && stage ? (
          <>
            <nav aria-label="選擇階段" className="flex flex-wrap items-center gap-1 border-b border-border">
              {stages.map((s) => {
                const on = s.key === stage.key
                return (
                  <Link
                    key={s.key}
                    href={`${BASE}?cohort=${cohort.id}&stage=${s.key}`}
                    aria-current={on ? 'page' : undefined}
                    className={cn(
                      '-mb-px inline-flex min-h-11 items-center border-b-2 px-3 text-sm font-semibold transition-colors',
                      on ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {s.name}
                  </Link>
                )
              })}
            </nav>
            {groups.length === 0 ? (
              <PanelEmpty title="這一屆還沒有組別" />
            ) : (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {groups.map((g) => {
                  const requirement = requirements.find((r) => r.groupId === g.id && r.stageKey === stage.key)
                  const mine = assignments.filter((a) => a.groupId === g.id && a.stageKey === stage.key)
                  const stageResult = gradebook.receipt.groups.find((x) => x.id === g.id)?.result.stages.find((s) => s.key === stage.key)
                  // 採計份數與成績表同一份（含已改派但保留的舊分數）。
                  const counted = stageResult?.counted.length ?? mine.filter((a) => a.state === 'counted').length
                  const keptFromEnded = stageResult?.counted.filter((c) => c.assignmentEnded) ?? []
                  // 已改派保留分數的老師也算已有評分：不能再被指派同一組同一階段。
                  const assigned = new Set([...mine.map((a) => a.teacherUserId), ...keptFromEnded.map((c) => c.teacherUserId)])
                  return (
                    <article key={g.id} aria-label={g.code} className="dash-card flex min-w-0 flex-col gap-3 px-4 py-3" data-testid={`grading-row-${g.code}`}>
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="tabular font-bold text-foreground">{g.code}</p>
                        <p className="truncate text-xs text-muted-foreground">指導：{g.advisorName ?? '尚未指派'}</p>
                      </div>
                      <div>
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
                          {requirement ? `已正式送出 ${counted}／${requirement.requiredCount} 份` : '還沒設定需要幾位老師評分'}
                          {requirement && mine.length > requirement.requiredCount ? `・指派 ${mine.length} 位，多於需要的人數` : ''}
                        </p>
                      </div>
                      {mine.length > 0 ? (
                        <ul className="flex flex-col gap-1.5">
                          {mine.map((a) => (
                            <AssignmentLine key={a.id} a={a} editable={!archived} />
                          ))}
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
                          stageKey={stage.key}
                          stageName={stage.name}
                          teachers={teachers.filter((t) => !assigned.has(t.userId))}
                          requestId={randomUUID()}
                        />
                      )}
                    </article>
                  )
                })}
              </div>
            )}
          </>
        ) : null}
      </section>
    </>,
  )
}

const LINK_BUTTON =
  'inline-flex min-h-9 items-center justify-center self-start rounded-lg border border-border bg-background px-2.5 text-[0.8rem] font-medium text-foreground hover:bg-muted'
