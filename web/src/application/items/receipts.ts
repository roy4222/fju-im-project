import { PLACEMENT_LABEL, RECEIVER_UNIT_LABEL, collectsResponses, describeDeadline } from '@/application/items/items'
import type { PublishReceipt, UpdateReceipt } from '@/application/items/ports'
import { formatTaipeiMinute } from '@/shared/time'

/**
 * 回執 → 畫面上的一句話（伺服器產生，畫面只顯示）。不寄信（Email 延後），所以寫「站內通知」。
 */

export function describePublishReceipt(receipt: PublishReceipt): string {
  const where = PLACEMENT_LABEL[receipt.placement]
  const opened = `實際開放時間 ${formatTaipeiMinute(new Date(receipt.actualOpenedAt))}（臺灣時間）`
  const notified = receipt.notifiedCount > 0 ? `已建立 ${receipt.notifiedCount} 則站內通知。` : '這次沒有發站內通知。'
  if (collectsResponses(receipt.placement)) {
    const unit = receipt.receiverUnit === 'group' ? `${receipt.rosterCount} 組` : `${receipt.rosterCount} 位`
    const due = receipt.dueAt ? `${describeDeadline(new Date(receipt.dueAt))}。` : ''
    return `「${receipt.title}」已發布到${where}（${RECEIVER_UNIT_LABEL[receipt.receiverUnit]}），需要繳交的名單 ${unit}；${opened}。${due}${notified}`
  }
  return `「${receipt.title}」已發布到${where}；${opened}。${notified}`
}

const CHANGE_LABEL: Record<UpdateReceipt['changes'][number], string> = {
  content: '內容（新內容版本）',
  schema: '繳交欄位（新的表單版本）',
  settings: '「誰看得到」或繳交設定',
  deadline: '截止時間',
}

export function describeUpdateReceipt(receipt: UpdateReceipt): string {
  const changed = receipt.changes.map((c) => CHANGE_LABEL[c]).join('、')
  const roster =
    receipt.rosterAdded > 0 || receipt.rosterRemoved > 0
      ? `需要繳交的名單加入 ${receipt.rosterAdded}、移除 ${receipt.rosterRemoved}。`
      : ''
  const due = receipt.changes.includes('deadline') && receipt.dueAt ? `${describeDeadline(new Date(receipt.dueAt))}。` : ''
  const notified = receipt.notify
    ? `已建立 ${receipt.notifiedCount} 則站內通知。`
    : receipt.notifiedCount > 0
      ? `沒有通知既有對象；新加入名單的 ${receipt.notifiedCount} 位收到新作業的通知。`
      : '沒有發通知。'
  return `「${receipt.title}」已更新：${changed}。${roster}${due}${notified}`
}
