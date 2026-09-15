/**
 * 故障注入的測試端（母 spec §5）。被測程式那一端在 `@/shared/fault-points`。
 *
 * 用法：
 * ```ts
 * using _ = withFaultInjection()          // 開旗標，離開作用域自動關
 * const undo = injectFault('uow.before-commit', () => { throw new Error('boom') })
 * ```
 */
import {
  clearFaultHandlers,
  registerFaultHandler,
  type FaultHandler,
  type FaultPointName,
} from '@/shared/fault-points'

export function enableFaultInjection(): () => void {
  const previous = process.env.FAULT_INJECTION_ENABLED
  process.env.FAULT_INJECTION_ENABLED = 'true'
  return () => {
    clearFaultHandlers()
    if (previous === undefined) delete process.env.FAULT_INJECTION_ENABLED
    else process.env.FAULT_INJECTION_ENABLED = previous
  }
}

export function injectFault(name: FaultPointName, handler: FaultHandler): () => void {
  return registerFaultHandler(name, handler)
}

/** 讓某個注入點丟例外，用來模擬「commit 前程序掛掉」這類中斷。 */
export function failAt(name: FaultPointName, message = `注入的故障：${name}`): () => void {
  return injectFault(name, () => {
    throw new Error(message)
  })
}
