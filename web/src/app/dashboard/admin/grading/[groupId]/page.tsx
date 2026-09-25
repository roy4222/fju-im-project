import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { Card, EmptyState } from '@/app/_ui/primitives'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { OverrideForm, ResolveReviewForm, ReturnForm } from '@/app/dashboard/admin/grading/results-forms'
import type { EvaluationHistoryEntry } from '@/application/grading'
import {
  adoptedFinal,
  describeFinalFormula,
  describeMissing,
  describeOverrideReceipt,
  describeRemoveAssignmentReceipt,
  describeReturnReceipt,
  describeStageFormula,
  describeStageStatus,
  getGradebookQuery,
  OVERRIDE_STATE_LABEL,
  REMOVAL_CHOICE_LABEL,
} from '@/composition/grading'
import { cn } from '@/shared/cn'
import { formatScore } from '@/shared/score'
import { formatTaipeiMinute } from '@/shared/time'

export const metadata = { title: '計算明細｜資管系專題平台' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const EVALUATION_STATE_TEXT: Record<EvaluationHistoryEntry['state'], string> = {
  draft: '暫存中（未正式）',
  counted: '採計中',
  historical: '歷史（不採計）',
  returned: '已退回',
  invalidated: '失效的暫存',
}

/**
 * 一組的計算明細（票 24；產品 06 §4「7.3」「7.5」、GRD-05–08、GRD-15；模組實作設計 06 §7.2「計算明細頁」）。只有管理員。
 *
 * - 每個階段：要求份數、採計中的每一份（老師、完整精度與兩位小數、是否已改派但分數保留）、平均的算式。
 * - 最終：算式（82.145 × 60% ＋ 90 × 40% ＝ 85.287 → 85.29）、採用值（有生效中的更正就用更正值）。
 * - 動作：退回某一份（指派仍有效才行）、更正最終結果（最終完成才行）、處理待復核的更正。
 * - 歷史：每一份評分（含退回、歷史、失效的暫存與原因）、指派紀錄（移除方式與理由）、更正紀錄。
 */
export default async function GroupGradeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ groupId: string }>
  searchParams: Promise<{ returned?: string | string[]; resolved?: string | string[]; reassigned?: string | string[] }>
}) {
  const { groupId } = await params
  // 退回、復核成功後由動作導回來（那一份或那一筆更正已不在原位置，表單跟著消失）：用 ID 查回這一頁的資料組一句回饋。
  const search = await searchParams
  const actor = await requireRole(`/dashboard/admin/grading${UUID.test(groupId) ? `/${groupId}` : ''}`, 'admin')
  if (!UUID.test(groupId)) notFound()
  const detail = await getGradebookQuery().groupDetail(actor, groupId)

  const back = detail.ok ? `/dashboard/admin/grading?cohort=${detail.receipt.group.cohortId}` : '/dashboard/admin/grading'
  const shell = (title: string, children: React.ReactNode) => (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/grading">
      <Link href={back} className="mb-4 inline-flex text-sm font-medium text-muted-foreground hover:text-foreground">
        ← 評分
      </Link>
      <header className="mb-5">
        <h1 className="text-xl font-semibold text-foreground">{title}</h1>
      </header>
      {children}
    </DashboardShell>
  )

  if (!detail.ok) return shell('計算明細', <EmptyState title="讀不到這一組的成績" description={detail.message} />)
  const d = detail.receipt
  const readOnly = d.group.archived || d.group.dissolved
  const current = d.overrides.find((o) => o.state !== 'superseded') ?? null
  const adopted = adoptedFinal(d.result, current)
  const formula = describeFinalFormula(d.result)
  const returnedEntry = d.evaluations.find((e) => e.evaluationId === search.returned && e.state === 'returned')
  const resolvedEntry = d.overrides.find((o) => o.id === search.resolved && o.state === 'effective')
  const ended = d.assignments.find((a) => a.id === search.reassigned && !a.active && a.removalChoice)
  const successor = ended ? d.assignments.find((a) => a.previousAssignmentId === ended.id) : undefined
  const notice = ended?.removalChoice
    ? describeRemoveAssignmentReceipt({
        groupCode: d.group.code,
        stageName: ended.stageName,
        teacherName: ended.teacherName,
        newTeacherName: successor?.teacherName ?? null,
        choice: ended.removalChoice,
        requiredCount: d.result.stages.find((s) => s.key === ended.stageKey)?.required ?? null,
      })
    : returnedEntry
    ? describeReturnReceipt({
        evaluationId: returnedEntry.evaluationId,
        groupCode: d.group.code,
        stageName: returnedEntry.stageName,
        teacherName: returnedEntry.teacherName,
      })
    : resolvedEntry
      ? `已處理待復核：${describeOverrideReceipt({
          overrideId: resolvedEntry.id,
          groupCode: d.group.code,
          originalValue: resolvedEntry.originalValue,
          newValue: resolvedEntry.newValue,
        })}`
      : null
  const overrideBlocked = readOnly
    ? '這一屆已封存或這一組已解散，成績只能查看。'
    : !d.result.complete
      ? '還有階段尚未完成，最終成績還沒出來，不能更正。'
      : current?.state === 'pending_review'
        ? '有一筆更正待復核，請先在下方處理。'
        : null

  return shell(
    `${d.group.code} 計算明細`,
    <div className="space-y-6">
      {notice ? (
        <p role="status" className="rounded-lg bg-primary-subtle px-3 py-2 text-sm text-primary-on-subtle">
          {notice}
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">
        {d.group.cohortCode}・{d.version ? `評分方案 v${d.version.versionNo}` : '還沒有評分方案'}
        {readOnly ? '・唯讀' : ''}
      </p>

      <Card title="最終成績">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p data-testid="adopted-final" className="text-3xl font-extrabold tabular-nums text-foreground">
              {adopted.value ?? '尚未完成'}
            </p>
            {adopted.source === 'override' && current ? (
              <p className="mt-1 text-sm text-primary">
                已更正：原 {formatScore(current.originalValue)} → {formatScore(current.newValue)}（{current.reason}；{current.actorName}，
                {formatTaipeiMinute(current.realAt)}，方案 v{current.schemeVersionNo}）
              </p>
            ) : null}
            {adopted.pendingReview ? <p className="mt-1 text-sm text-danger">更正待復核：計算基礎已改變，原更正暫不套用。</p> : null}
            <p data-testid="final-formula" className="mt-2 text-sm tabular-nums text-muted-foreground">
              {formula ?? '還有階段尚未完成，最終成績等全部階段完成才算。'}
            </p>
          </div>
          <OverrideForm
            groupId={d.group.id}
            groupCode={d.group.code}
            computed={d.result.finalDisplay}
            basisHash={d.basisHash}
            requestId={randomUUID()}
            disabledReason={overrideBlocked}
          />
        </div>
        {current?.state === 'pending_review' ? (
          <div className="mt-4">
            <ResolveReviewForm
              groupId={d.group.id}
              overrideId={current.id}
              previousValue={formatScore(current.newValue)}
              computed={d.result.finalDisplay}
              basisHash={d.basisHash}
              requestId={randomUUID()}
              disabledReason={
                readOnly ? '唯讀，不能處理。' : !d.result.complete ? '新的計算基礎還有階段尚未完成，等各階段完成後再處理。' : null
              }
            />
          </div>
        ) : null}
      </Card>

      {d.result.stages.map((s) => (
        <Card key={s.key} title={`${s.name}（占 ${s.weight}%）`}>
          <div className="space-y-3" data-testid={`detail-stage-${s.key}`}>
            <p className="text-sm">
              <span className={cn('font-semibold', s.complete ? 'text-foreground' : 'text-danger')}>{describeStageStatus(s)}</span>
              <span className="ml-2 tabular-nums text-muted-foreground">
                採計 {s.counted.length}／要求 {s.required ?? '未設定'}
              </span>
            </p>
            <p className="text-sm tabular-nums text-foreground" data-testid="stage-formula">
              {describeStageFormula(s)}
            </p>
            {s.counted.length > 0 ? (
              <div className="overflow-x-auto rounded-card border border-border">
                <table className="w-full min-w-[40rem] text-sm" aria-label={`${s.name} 採計中的評分`}>
                  <thead className="bg-muted text-left text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2 font-medium">評分老師</th>
                      <th className="px-4 py-2 font-medium">各項原始輸入</th>
                      <th className="px-4 py-2 text-right font-medium">分數（完整精度）</th>
                      <th className="px-4 py-2 font-medium">正式送出</th>
                      <th className="px-4 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {s.counted.map((c) => (
                      <tr key={c.evaluationId} className="border-t border-border">
                        <td className="px-4 py-2">
                          {c.teacherName}
                          {c.assignmentEnded ? <span className="ml-2 text-xs text-muted-foreground">已改派，分數保留</span> : null}
                          {c.gate ? <span className="ml-2 text-xs text-muted-foreground">{c.gate === 'pass' ? '通過' : '不通過'}</span> : null}
                        </td>
                        <td className="px-4 py-2 text-xs tabular-nums text-muted-foreground">
                          {(d.version?.stages.find((x) => x.key === s.key)?.items ?? [])
                            .map((i) => `${i.name} ${c.scores[i.key] ?? '—'}${i.type === 'number' ? `／${i.max}` : ''}`)
                            .join('、')}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          <b>{c.display}</b>
                          {c.exact !== c.display ? <span className="ml-1 text-xs text-muted-foreground">（{c.exact}）</span> : null}
                        </td>
                        <td className="px-4 py-2 tabular-nums text-muted-foreground">{formatTaipeiMinute(c.submittedAt)}</td>
                        <td className="px-4 py-2 text-right">
                          {!readOnly && !c.assignmentEnded ? (
                            <ReturnForm groupId={d.group.id} evaluationId={c.evaluationId} teacherName={c.teacherName} stageName={s.name} requestId={randomUUID()} />
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {d.missing.filter((m) => m.stageKey === s.key).length > 0 ? (
              <ul className="space-y-0.5 text-sm">
                {d.missing
                  .filter((m) => m.stageKey === s.key)
                  .map((m) => (
                    <li key={m.assignmentId} className={m.teacherInactive ? 'text-danger' : 'text-muted-foreground'}>
                      缺評：{describeMissing(m)}
                      {m.teacherInactive ? '請移除或改派。' : ''}
                    </li>
                  ))}
              </ul>
            ) : null}
          </div>
        </Card>
      ))}

      <Card title="評分紀錄" description="每一份老師輸入都保留（不可改）；退回、替換、失效的暫存與原因只有系辦看得到。">
        {d.evaluations.length === 0 ? (
          <p className="text-sm text-muted-foreground">還沒有任何評分。</p>
        ) : (
          <div className="overflow-x-auto rounded-card border border-border">
            <table className="w-full min-w-[44rem] text-sm" aria-label="評分紀錄">
              <thead className="bg-muted text-left text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">階段</th>
                  <th className="px-4 py-2 font-medium">老師</th>
                  <th className="px-4 py-2 font-medium">狀態</th>
                  <th className="px-4 py-2 text-right font-medium">分數</th>
                  <th className="px-4 py-2 font-medium">時間</th>
                  <th className="px-4 py-2 font-medium">原因</th>
                </tr>
              </thead>
              <tbody>
                {d.evaluations.map((e) => (
                  <tr key={e.evaluationId} className="border-t border-border" data-testid="evaluation-history">
                    <td className="px-4 py-2">{e.stageName}</td>
                    <td className="px-4 py-2">{e.teacherName}</td>
                    <td className="px-4 py-2">{EVALUATION_STATE_TEXT[e.state]}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{e.display}</td>
                    <td className="px-4 py-2 tabular-nums text-muted-foreground">{formatTaipeiMinute(e.submittedAt)}</td>
                    <td className="px-4 py-2 text-muted-foreground">{e.lastReason ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="評分指派紀錄">
        {d.assignments.length === 0 ? (
          <p className="text-sm text-muted-foreground">還沒有指派評分老師。</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {d.assignments.map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium text-foreground">{a.stageName}・{a.teacherName}</span>
                {a.active ? (
                  <>
                    <span className="text-xs text-primary">有效</span>
                    {a.teacherInactive ? <span className="text-xs text-danger">帳號已停用，待管理員處理</span> : null}
                    {!readOnly ? (
                      <Link href={`/dashboard/admin/grading/reassign/${a.id}`} className="text-xs font-medium text-primary underline-offset-2 hover:underline">
                        移除／改派
                      </Link>
                    ) : null}
                  </>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    已結束（{a.removalChoice ? REMOVAL_CHOICE_LABEL[a.removalChoice] : '移除'}：{a.reason}）
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {d.overrides.length > 0 ? (
        <Card title="更正紀錄" description="每一筆更正都保留（原值、新值、理由、操作者、時間、方案版本）。">
          <ul className="space-y-1 text-sm" aria-label="更正紀錄">
            {d.overrides.map((o) => (
              <li key={o.id} className="tabular-nums">
                {formatTaipeiMinute(o.realAt)}・v{o.schemeVersionNo}・原 {formatScore(o.originalValue)} → {formatScore(o.newValue)}・{o.reason}・{o.actorName}・
                <span className={o.state === 'pending_review' ? 'text-danger' : 'text-muted-foreground'}>{OVERRIDE_STATE_LABEL[o.state]}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>,
  )
}
