import type { AuditEventInput, LedgerBeginResult, LedgerOperation } from '@/application/ops/records'

/**
 * 模組 10 提供給所有用例的兩個 port（模組 10 §5）。
 *
 * 兩個都吃一個 `tx`：稽核與帳本一定要跟業務寫入**在同一個交易裡**，
 * 用例失敗時整體回滾，不會留下「做了一半」的紀錄（契約 01 §8）。
 * `tx` 的型別由 infrastructure 決定，application 只當它是一個不透明的把手。
 */
export interface AuditWriter<Tx = unknown> {
  append(tx: Tx, event: AuditEventInput): Promise<string>
}

export interface OperationLedger<Tx = unknown> {
  /** ON CONFLICT 協議（契約 01 §8）：第一次／重播／內容不符三種結果。 */
  begin(tx: Tx, operation: LedgerOperation, committedRealAt: Date): Promise<LedgerBeginResult>
  /** 用例成功後把回執與結果參照補上去。 */
  commit(tx: Tx, recordId: string, payload: { receipt: unknown; resultRef: unknown }): Promise<void>
  /**
   * 已 commit 的用例，之後的外部步驟失敗了（契約 01 §8：「`state='failed'` 只用在已 commit 但後續外部步驟失敗」）。
   * 同一個 requestId 重送時 `begin` 會回 `state: 'failed'`，用例不能再回「已完成」（票 10b）。
   */
  markFailed(tx: Tx, recordId: string): Promise<void>
  /** 查回執：只回本人的紀錄；回執過期回 `RECEIPT_EXPIRED` 與 `result_ref`。 */
  get(actorUserId: string, operationKind: string, requestId: string): Promise<LedgerBeginResult>
}
