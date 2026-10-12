import type { SignoffState } from '@/application/signoff'
import { describeCause, STATE_LABEL } from '@/composition/signoff'

/**
 * 同意書狀態徽章的字（清單與詳情共用）。`superseded` 要看有沒有新版才知道怎麼說：
 * 已經有新版 →「已被第 N 版取代」；指導老師或組員變更、系辦還沒建新版 →「已作廢（原因）」，
 * 才不會跟同頁「等系辦建立新版」的說明打架。
 */
export function signoffStateLabel(state: SignoffState, opts: { cause?: string | null; newerVersionNo?: number | null } = {}): string {
  if (state !== 'superseded') return STATE_LABEL[state]
  if (opts.newerVersionNo != null) return `已被第 ${opts.newerVersionNo} 版取代`
  const cause = describeCause(opts.cause ?? null)
  return `已作廢${cause ? `（${cause}）` : ''}`
}

/** 版本歷史裡比 `versionNo` 新的第一版（沒有就是 null）。 */
export function newerVersionNo(versionNo: number, history: readonly { readonly versionNo: number }[]): number | null {
  const newer = history.map((h) => h.versionNo).filter((n) => n > versionNo)
  return newer.length > 0 ? Math.min(...newer) : null
}
