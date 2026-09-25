import type { CreateDraftReceipt, UpdateDraftReceipt } from '@/application/showcase/ports'

/** 精選草稿動作成功後給管理員看的一句話（畫面經 composition 取用）。 */

export function describeCreateDraftReceipt(r: CreateDraftReceipt): string {
  return `已替 ${r.groupCode} 建立精選草稿；填好題目、摘要、海報與影片連結後按「儲存草稿」。`
}

export function describeUpdateDraftReceipt(r: UpdateDraftReceipt): string {
  return `${r.groupCode} 的精選草稿已儲存（第 ${r.revision} 版）${r.posterChanged ? '，海報已更新' : ''}。草稿不會公開。`
}
