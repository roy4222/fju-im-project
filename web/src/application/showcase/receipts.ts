import { AWARD_LEVEL_LABEL } from '@/application/showcase/lifecycle'
import type {
  CreateDraftReceipt,
  PublishReceipt,
  SetAwardReceipt,
  ShowcaseLifecycleReceipt,
  UpdateDraftReceipt,
} from '@/application/showcase/ports'

/** 精選草稿動作成功後給管理員看的一句話（畫面經 composition 取用）。 */

export function describeCreateDraftReceipt(r: CreateDraftReceipt): string {
  return `已替 ${r.groupCode} 建立精選草稿；填好題目、摘要、海報與影片連結後按「儲存草稿」。`
}

export function describeUpdateDraftReceipt(r: UpdateDraftReceipt): string {
  return `${r.groupCode ?? '歷屆補登'} 的精選草稿已儲存（第 ${r.revision} 版）${r.posterChanged ? '，海報已更新' : ''}。草稿不會公開。`
}

const who = (r: ShowcaseLifecycleReceipt) => `${r.groupCode ?? '歷屆補登'}「${r.title || '（未填題目）'}」`

export function describePublishReceipt(r: PublishReceipt): string {
  return `${who(r)} 已發布（第 ${r.versionNo} 版），登入後的歷屆一覽看得到；有選獎項才會出現在「優秀專題」與首頁輪播。`
}

export function describeWithdrawReceipt(r: ShowcaseLifecycleReceipt): string {
  return `${who(r)} 已下架，前台看不到了；之後可以按「重新發布」。`
}

export function describeRepublishReceipt(r: ShowcaseLifecycleReceipt): string {
  return `${who(r)} 已重新發布，前台又看得到了。`
}

export function describeSetAwardReceipt(r: SetAwardReceipt): string {
  if (!r.award) return `${who(r)} 已拿掉獎項，不會出現在「優秀專題」與首頁輪播。`
  const name = r.awardLabel ?? AWARD_LEVEL_LABEL[r.award]
  return `${who(r)} 的獎項已設為「${name}」；公開中時會出現在「優秀專題」與首頁輪播。`
}

export function describeDeleteReceipt(r: ShowcaseLifecycleReceipt): string {
  return `已刪除 ${who(r)}；看板與前台都不再出現，操作紀錄留有一筆。`
}
