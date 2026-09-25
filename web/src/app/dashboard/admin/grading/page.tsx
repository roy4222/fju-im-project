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
import type { AdminAssignmentView, SchemeVersionView } from '@/application/grading'
import { getCohortStatusQuery } from '@/composition/cohorts'
import {
  describeFormula,
  EVALUATION_STATE_LABEL,
  getGradingQuery,
  ITEM_TYPE_LABEL,
  MAX_REQUIRED_COUNT,
  SCHEME_STATUS_LABEL,
} from '@/composition/grading'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute } from '@/shared/time'

export const metadata = { title: '評分管理｜資管系專題平台' }

/**
 * 管理員「評分」（票 23；原型 `/dashboard/admin/grading`）。
 *
 * 一頁三件事，由上而下：評分方案（目前版本、公式、版本清單與發布）、每組每階段的要求份數與評分老師、
 * 各份評分的狀態（未開始／暫存（未正式）／已正式送出）。平均、最終成績、退回、更正、改派三選一與匯出在票 24。
 * 暫存只有本人與管理員看得到：這一頁是管理員頁，所以列出暫存分數並標「未正式」。
 */

function versionLabel(v: SchemeVersionView, current: SchemeVersionView | null): string {
  if (v.isCurrent) return `${SCHEME_STATUS_LABEL[v.status]}・目前使用`
  if (v.status === 'draft') return '草稿'
  return current && v.versionNo < current.versionNo ? '已被新版本取代' : SCHEME_STATUS_LABEL[v.status]
}

function AssignmentLine({ a }: { a: AdminAssignmentView }) {
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
    </li>
  )
}

export default async function AdminGradingPage({
  searchParams,
}: {
  searchParams: Promise<{ cohort?: string | string[]; stage?: string | string[] }>
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

  const board = await getGradingQuery().adminBoard(actor, cohort.id)
  if (!board.ok) return shell(<EmptyState title="讀不到評分資料" description={board.message} />)
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
                  ? '已有老師開始評分（暫存或正式送出），結構已鎖定；要改階段、項目、滿分或權重請建立新版本（套用新版本在下一階段開放）。'
                  : '還沒有老師開始評分：可以建立新版本並發布取代目前版本。第一位老師暫存或送出評分後就鎖定。'
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
                      {v.status === 'draft' ? (
                        <PublishButton
                          versionId={v.id}
                          versionNo={v.versionNo}
                          requestId={randomUUID()}
                          disabledReason={locked ? `v${current!.versionNo} 已鎖定，不能直接換版本。` : null}
                        />
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

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
                    const counted = mine.filter((a) => a.state === 'counted').length
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
                                <AssignmentLine key={a.id} a={a} />
                              ))}
                            </ul>
                          ) : (
                            <span className="text-sm text-muted-foreground">還沒有指派</span>
                          )}
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
            各組平均與最終成績、退回重評、更正、移除或改派評分老師、匯出在下一階段開放。
          </p>
        </Card>
      ) : null}
    </>,
  )
}
