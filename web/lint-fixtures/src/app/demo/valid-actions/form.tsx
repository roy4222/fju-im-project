'use client'
// 合法例 1：Client Component 匯入同目錄 actions.ts，拿到的是 Server Function 參照。
import { submitDemo } from './actions'

export function DemoForm() {
  return <button onClick={() => submitDemo(crypto.randomUUID())}>送出</button>
}
