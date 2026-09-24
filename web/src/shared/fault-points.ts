/**
 * 故障注入點（母 spec §5、契約 04 §2）。
 *
 * 被測程式在「可以被中斷的位置」呼叫 `reachFaultPoint('<名稱>')`，正常情況下這是
 * 一個立即回傳的 no-op；只有在 `FAULT_INJECTION_ENABLED=true` 的環境（測試）才會
 * 查註冊表並執行注入的行為。production 沒有人註冊，也讀不到旗標，所以永遠是 no-op。
 *
 * 注入的具體行為（丟例外、卡住等會合、延遲）由測試端 `web/test/fault-injection.ts` 提供。
 */

export type FaultPointName =
  | 'uow.before-commit'
  | 'uow.after-commit'
  | 'outbox.after-insert'
  | 'worker.before-claim'
  | 'worker.after-claim'
  | 'worker.before-handler'
  | 'projection.after-notifications'
  | 'revocation.before-call'
  | 'file.after-upload'
  /** 票 13：組別、成員、組長寫好、占用刪掉，還沒發事件與 commit（證明成立是單一交易、測並發時卡住成立中的交易）。 */
  | 'group.establish.after-release'
  /** 票 14：管理員加人查完資格、還沒寫組員列（測加人與發起／確認提案的並發）。 */
  | 'group.member.add.before-insert'
  /** 票 19：認領查完「還沒有主指導」、還沒寫指派列（測資料庫部分唯一這道後備防線）。 */
  | 'advisor.claim.before-insert'
  /** 票 15：發布時名單已展開寫入，還沒排到期工作、發事件與 commit（證明發布是單一交易）。 */
  | 'item.publish.after-roster'

export type FaultHandler = () => void | Promise<void>

const handlers = new Map<FaultPointName, FaultHandler>()

function enabled(): boolean {
  return process.env.FAULT_INJECTION_ENABLED === 'true'
}

/** 被測程式呼叫的那一端。沒開旗標時完全不做事。 */
export async function reachFaultPoint(name: FaultPointName): Promise<void> {
  if (!enabled()) return
  const handler = handlers.get(name)
  if (handler) await handler()
}

/** 測試端註冊行為；回傳的函式用來取消註冊。 */
export function registerFaultHandler(name: FaultPointName, handler: FaultHandler): () => void {
  if (!enabled()) {
    throw new Error('要注入故障必須先設 FAULT_INJECTION_ENABLED=true；production 不允許。')
  }
  handlers.set(name, handler)
  return () => {
    if (handlers.get(name) === handler) handlers.delete(name)
  }
}

export function clearFaultHandlers(): void {
  handlers.clear()
}

export function registeredFaultPoints(): FaultPointName[] {
  return [...handlers.keys()]
}
