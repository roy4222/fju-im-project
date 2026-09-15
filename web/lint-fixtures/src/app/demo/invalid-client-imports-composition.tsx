'use client'
// 反例 5：Client Component 不可以把組裝根拉進瀏覽器，應該呼叫同目錄的 actions.ts。
// 預期被擋：fju/client-server-boundary
import { getDemoUseCase } from '../../composition/demo'

export function Widget() {
  return <button onClick={() => getDemoUseCase()}>送出</button>
}
