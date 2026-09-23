import 'server-only'
import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * 「這是內部呼叫」的標記（契約 03 §2、母 spec §4.12）。
 *
 * Better Auth 的管理員能力只能由 application 用例經包裝器呼叫。hook 判定內部呼叫要
 * **兩個條件同時成立**：
 * 1. `ctx.request` 不存在（官方 hooks 文件：request「may not exist in server-only endpoints」）；
 * 2. 這個 AsyncLocalStorage 的 marker 存在。
 *
 * 刻意不用 header：header 可以偽造，AsyncLocalStorage 的內容不會跟著 HTTP 請求進來。
 * 兩個條件缺一不可——只看 (1) 的話，任何伺服器端程式碼直接呼叫 `auth.api.banUser` 就繞過了；
 * 只看 (2) 的話，marker 若因為某個 bug 洩漏到請求處理的 async context 裡就形同虛設。
 */

const storage = new AsyncLocalStorage<{ readonly marker: symbol }>()

/** 只有這個模組看得到的 marker；不匯出，外面偽造不了。 */
const INTERNAL_MARKER = Symbol('fju.internal-auth-call')

/** 在「內部呼叫」的 context 裡執行；只由 wrapper 的內部包裝器使用。 */
export function runAsInternalCall<T>(fn: () => Promise<T>): Promise<T> {
  return storage.run({ marker: INTERNAL_MARKER }, fn)
}

/** 現在是不是在內部呼叫的 context 裡。 */
export function isInternalCall(): boolean {
  return storage.getStore()?.marker === INTERNAL_MARKER
}
