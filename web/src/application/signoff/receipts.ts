import type { CreateVersionReceipt, RemindReceipt, RespondReceipt, RestartReceipt, VoidReceipt } from '@/application/signoff/ports'
import { RESTART_LABEL, VOTE_RESULT_LABEL } from '@/application/signoff/approval'
import { PURPOSE_LABEL, STATE_LABEL } from '@/application/signoff/version'
import { formatTaipeiMinute } from '@/shared/time'

/** 簽核動作成功後給操作者看的一句話（畫面經 composition 取用）。 */

export function describeCreateVersionReceipt(r: CreateVersionReceipt): string {
  const superseded = r.supersededVersionNo !== null ? `；原本的 v${r.supersededVersionNo} 已失效，要重新簽核` : ''
  return (
    `已建立 ${r.groupCode}「${PURPOSE_LABEL[r.purpose]}」v${r.versionNo}：參與者 ${r.studentCount} 位學生＋主指導 ${r.advisorName}` +
    `${superseded}。每位參與學生已收到「輪到你同意」。`
  )
}

/** 本人表態後的回執（只講自己這一票與目前進度）。 */
export function describeRespondReceipt(r: RespondReceipt): string {
  const mine = `已記錄你的「${VOTE_RESULT_LABEL[r.result]}」（${formatTaipeiMinute(new Date(r.realAt))}），只代表你自己一票。`
  switch (r.state) {
    case 'teacher_pending':
      return `${mine}全部 ${r.total} 位學生都已同意，現在輪到指導老師。`
    case 'complete':
      return `${mine}${r.groupCode}「${PURPOSE_LABEL[r.purpose]}」v${r.versionNo} 站內簽核已完成。`
    case 'revision':
      return `${mine}這一版已退回修正，等系辦重開新版後大家再重新閱讀。`
    default:
      return `${mine}目前 ${r.agreed}／${r.total} 位學生已同意（${STATE_LABEL[r.state]}）。`
  }
}

export function describeRestartReceipt(r: RestartReceipt): string {
  return (
    `已${RESTART_LABEL[r.kind]}：${r.groupCode}「${PURPOSE_LABEL[r.purpose]}」建立 v${r.versionNo}（內容與 v${r.fromVersionNo} 相同），` +
    `參與者依此刻重新計算：${r.studentCount} 位學生＋主指導 ${r.advisorName}。舊版與舊同意留作歷史，不計入新版；每位參與學生已收到「輪到你同意」。`
  )
}

export function describeVoidReceipt(r: VoidReceipt): string {
  return `已作廢 ${r.groupCode}「${PURPOSE_LABEL[r.purpose]}」v${r.versionNo}；之後誰都不能再表態，要重新簽核請按「重開新版」。`
}

export function describeRemindReceipt(r: RemindReceipt): string {
  const who = [r.studentCount > 0 ? `${r.studentCount} 位學生` : null, r.advisorIncluded ? '指導老師' : null].filter(Boolean).join('與')
  return `已提醒 ${r.groupCode} v${r.versionNo} 還沒表態的 ${who || '0 人'}；24 小時內不能再提醒同一版。`
}
