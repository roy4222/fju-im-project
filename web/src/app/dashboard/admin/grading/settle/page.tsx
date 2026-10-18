import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { DataTableFrame, DT, EmptyRow } from '@/app/_ui/data-table'
import { CohortPills, PageTitle, Panel, PanelEmpty, Pill, QuietState } from '@/app/_ui/dashboard/primitives'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { AdminTabs } from '@/app/dashboard/admin/_tabs'
import { GRADING_TABS } from '@/app/dashboard/admin/_tabs.consts'
import { ReleaseForm, SettleForm } from '@/app/dashboard/admin/grading/settle/settle-forms'
import { cohortLabel, getCohortStatusQuery } from '@/composition/cohorts'
import { getGradebookQuery, getGradingSettlementQuery } from '@/composition/grading'
import { formatTaipeiMinute } from '@/shared/time'

export const metadata = { title: '成績結算｜資管系專題平台' }

const GRADING = '/dashboard/admin/grading'
const BASE = `${GRADING}/settle`

/**
 * 系辦成績結算頁（B 階段 AD-B1；設計方案 §2.5）。
 *
 * - 目前評分規則版本的每個階段一列：階段名、採計份數／應有份數、狀態（未結算／已結算 {時間}・{人}・理由）、
 *   「結算」或「解除結算」（理由對話框，必填）。
 * - 下方「結算紀錄」：含已解除的，新的在前。
 * - 屆別已封存：只讀，不顯示按鈕（伺服器端也擋 `COHORT_ARCHIVED`）。
 *
 * 讀取三次：屆別、`gradebook`（目前版本與各組採計份數，跟成績表同一份）、`settlements`。
 * 未結算列的採計份數跟成績管理頁的階段卡同口徑（解散的組不算）；已結算列顯示結算當下記下的份數。
 */
export default async function AdminGradingSettlePage({ searchParams }: { searchParams: Promise<{ cohort?: string | string[] }> }) {
  // 授權檢查在**頁面自己**（見 `_nav.ts` 與 `guard.ts`）。
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
          <PageTitle title="成績" />
          <AdminTabs label="成績分頁" current={BASE} items={GRADING_TABS} />
        </div>
        <p data-testid="tab-intro" className="-mt-2 mb-4 text-sm text-muted-foreground">
          把老師送出的評分結算成各階段的正式成績。
        </p>
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

  const [book, history] = await Promise.all([getGradebookQuery().gradebook(actor, cohort.id), getGradingSettlementQuery().settlements(actor, cohort.id)])
  if (!book.ok) return shell(<QuietState title="讀不到成績" hint={book.message} />)
  if (!history.ok) return shell(<QuietState title="讀不到結算紀錄" hint={history.message} />)
  const archived = book.receipt.cohort.archived
  const stages = book.receipt.version?.stages ?? []
  const active = new Map(history.receipt.filter((h) => h.releasedAt === null).map((h) => [h.stageKey, h]))

  const rows = stages.map((s) => {
    let counted = 0
    let required = 0
    for (const g of book.receipt.groups) {
      if (g.dissolved) continue
      const r = g.result.stages.find((x) => x.key === s.key)
      if (!r) continue
      counted += r.counted.length
      required += r.required ?? 0
    }
    return { key: s.key, name: s.name, counted, required, settlement: active.get(s.key) ?? null }
  })

  return shell(
    <>
      {archived ? (
        <p role="status" data-testid="cohort-archived" className="rounded-lg bg-muted px-4 py-2.5 text-sm text-muted-foreground">
          {cohortLabel(book.receipt.cohort)}已封存，結算只能查看；要修改請先解封。
        </p>
      ) : null}

      <Panel title="各階段結算" aria-label="各階段結算" bodyClassName="px-4 pb-4">
        {!book.receipt.version ? (
          <PanelEmpty
            title="還沒有發布的評分規則"
            action={
              <Link href={`${GRADING}/rules?cohort=${cohort.id}`} className="text-sm font-semibold text-primary hover:underline">
                前往評分規則
              </Link>
            }
          />
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              結算後，老師不能再暫存、送出或重新送出這個階段的分數，系辦也不能退回；更正最終成績與套用新評分規則不受影響。
            </p>
            <DataTableFrame>
              <table aria-label="各階段結算" className={DT.table}>
                <thead className={DT.thead}>
                  <tr>
                    <th className={DT.th}>階段</th>
                    <th className={`${DT.th} text-right`}>採計份數／應有份數</th>
                    <th className={DT.th}>狀態</th>
                    <th className={DT.th}>
                      <span className="sr-only">動作</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key} className={`${DT.tr} align-top`} data-testid={`settle-row-${r.key}`}>
                      <td className={`${DT.td} font-bold text-foreground`}>{r.name}</td>
                      <td className={`${DT.td} text-right tabular-nums`} data-testid="counted">
                        {r.settlement ? r.settlement.countedEvaluations : r.counted}／{r.required}
                      </td>
                      <td className={DT.td} data-testid="settle-status">
                        {r.settlement ? (
                          <>
                            <p>
                              <Pill tone="success">已結算</Pill>{' '}
                              <span className="tabular-nums text-sm text-foreground">
                                {formatTaipeiMinute(r.settlement.settledAt)}・{r.settlement.settledBy.name}
                              </span>
                            </p>
                            <p className="mt-0.5 text-xs text-muted-foreground">理由：{r.settlement.reason}</p>
                          </>
                        ) : (
                          <Pill tone="default">未結算</Pill>
                        )}
                      </td>
                      <td className={`${DT.td} text-right`}>
                        {archived ? null : r.settlement ? (
                          <ReleaseForm settlementId={r.settlement.settlementId} stageName={r.name} requestId={randomUUID()} />
                        ) : (
                          <SettleForm cohortId={cohort.id} stageKey={r.key} stageName={r.name} requestId={randomUUID()} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </DataTableFrame>
          </div>
        )}
      </Panel>

      <Panel title="結算紀錄" aria-label="結算紀錄" bodyClassName="px-4 pb-4">
        <DataTableFrame>
          <table aria-label="結算紀錄" className={DT.table}>
            <thead className={DT.thead}>
              <tr>
                <th className={DT.th}>階段</th>
                <th className={DT.th}>結算</th>
                <th className={`${DT.th} text-right`}>採計份數</th>
                <th className={DT.th}>解除</th>
              </tr>
            </thead>
            <tbody>
              {history.receipt.length === 0 ? (
                <EmptyRow colSpan={4} title="還沒有結算紀錄" />
              ) : (
                history.receipt.map((h) => (
                  <tr key={h.settlementId} className={`${DT.tr} align-top`} data-testid="settlement-history">
                    <td className={`${DT.td} font-semibold text-foreground`}>{h.stageName}</td>
                    <td className={DT.td}>
                      <p className="tabular-nums">
                        {formatTaipeiMinute(h.settledAt)}・{h.settledBy.name}
                      </p>
                      <p className="text-xs text-muted-foreground">理由：{h.reason}</p>
                    </td>
                    <td className={`${DT.td} text-right tabular-nums`}>{h.countedEvaluations}</td>
                    <td className={DT.td} data-testid="released">
                      {h.releasedAt ? (
                        <>
                          <p className="tabular-nums">
                            {formatTaipeiMinute(h.releasedAt)}・{h.releasedBy?.name ?? ''}
                          </p>
                          <p className="text-xs text-muted-foreground">理由：{h.releaseReason}</p>
                        </>
                      ) : (
                        <Pill tone="success">結算中</Pill>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </DataTableFrame>
      </Panel>
    </>,
  )
}
