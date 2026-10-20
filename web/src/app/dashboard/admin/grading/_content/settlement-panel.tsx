import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { requireRole } from '@/app/_ui/guard'
import { DataTableFrame, DT, EmptyRow } from '@/app/_ui/data-table'
import { Panel, PanelEmpty, Pill, QuietState } from '@/app/_ui/dashboard/primitives'
import { ReleaseForm, SettleForm } from '@/app/dashboard/admin/grading/settle/settle-forms'
import { cohortLabel } from '@/composition/cohorts'
import { getGradebookQuery, getGradingSettlementQuery } from '@/composition/grading'
import { formatTaipeiMinute } from '@/shared/time'

const GRADING = '/dashboard/admin/grading'
const BASE = `${GRADING}/settle`

/**
 * 「成績」的「結算」分頁內容（C 階段規格① §7.4、§11.2；B 階段 AD-B1 的結算頁搬進來，內容不動、理由改選填）。
 *
 * - 目前評分規則版本的每個評分項目一列：名稱、採計份數／應有份數、狀態（未結算／已結算 {時間}・{人}・理由）、
 *   「結算」或「解除結算」（確認對話框，理由選填）。
 * - 下方「結算紀錄」：含已解除的，新的在前。
 * - 屆別已封存：只讀，不顯示按鈕（伺服器端也擋 `COHORT_ARCHIVED`）。
 *
 * 讀取兩次：`gradebook`（目前版本與各組採計份數，跟成績表同一份）、`settlements`。
 * 未結算列的採計份數跟成績表的評分項目卡同口徑（解散的組不算）；已結算列顯示結算當下記下的份數。
 */
export async function SettlementPanel({ cohortId }: { cohortId: string }) {
  const actor = await requireRole(BASE, 'admin')
  const [book, history] = await Promise.all([getGradebookQuery().gradebook(actor, cohortId), getGradingSettlementQuery().settlements(actor, cohortId)])
  if (!book.ok) return <QuietState title="讀不到成績" hint={book.message} />
  if (!history.ok) return <QuietState title="讀不到結算紀錄" hint={history.message} />
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

  return (
    <>
      {archived ? (
        <p role="status" data-testid="cohort-archived" className="rounded-lg bg-muted px-4 py-2.5 text-sm text-muted-foreground">
          {cohortLabel(book.receipt.cohort)}已封存，結算只能查看；要修改請先解封。
        </p>
      ) : null}

      <Panel title="各評分項目結算" aria-label="各評分項目結算" bodyClassName="px-4 pb-4">
        {!book.receipt.version ? (
          <PanelEmpty
            title="還沒有發布的評分規則"
            action={
              <Link href={`${GRADING}/rules?cohort=${cohortId}`} className="text-sm font-semibold text-primary hover:underline">
                前往評分規則
              </Link>
            }
          />
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              結算後，老師不能再暫存、送出或重新送出這個評分項目的分數，系辦也不能退回；更正最終成績與套用新評分規則不受影響。
            </p>
            <DataTableFrame>
              <table aria-label="各評分項目結算" className={DT.table}>
                <thead className={DT.thead}>
                  <tr>
                    <th className={DT.th}>評分項目</th>
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
                            {r.settlement.reason ? <p className="mt-0.5 text-xs text-muted-foreground">理由：{r.settlement.reason}</p> : null}
                          </>
                        ) : (
                          <Pill tone="default">未結算</Pill>
                        )}
                      </td>
                      <td className={`${DT.td} text-right`}>
                        {archived ? null : r.settlement ? (
                          <ReleaseForm settlementId={r.settlement.settlementId} stageName={r.name} requestId={randomUUID()} />
                        ) : (
                          <SettleForm cohortId={cohortId} stageKey={r.key} stageName={r.name} requestId={randomUUID()} />
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
                <th className={DT.th}>評分項目</th>
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
                      {h.reason ? <p className="text-xs text-muted-foreground">理由：{h.reason}</p> : null}
                    </td>
                    <td className={`${DT.td} text-right tabular-nums`}>{h.countedEvaluations}</td>
                    <td className={DT.td} data-testid="released">
                      {h.releasedAt ? (
                        <>
                          <p className="tabular-nums">
                            {formatTaipeiMinute(h.releasedAt)}・{h.releasedBy?.name ?? ''}
                          </p>
                          {h.releaseReason ? <p className="text-xs text-muted-foreground">理由：{h.releaseReason}</p> : null}
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
    </>
  )
}
