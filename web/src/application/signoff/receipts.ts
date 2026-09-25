import type { CreateVersionReceipt } from '@/application/signoff/ports'
import { PURPOSE_LABEL } from '@/application/signoff/version'

/** 簽核動作成功後給管理員看的一句話（畫面經 composition 取用）。 */

export function describeCreateVersionReceipt(r: CreateVersionReceipt): string {
  const superseded = r.supersededVersionNo !== null ? `；原本的 v${r.supersededVersionNo} 已失效，要重新簽核` : ''
  return (
    `已建立 ${r.groupCode}「${PURPOSE_LABEL[r.purpose]}」v${r.versionNo}：參與者 ${r.studentCount} 位學生＋主指導 ${r.advisorName}` +
    `${superseded}。每位參與學生已收到「輪到你同意」。`
  )
}
