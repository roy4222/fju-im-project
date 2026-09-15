'use server'
// 反例 6：頂層 'use server' 的檔案所有匯出都必須是 async 函式。
// 預期被擋：fju/actions-file-contract
export const DEMO_LIMIT = 10

export function submitDemo() {
  return { ok: true }
}
