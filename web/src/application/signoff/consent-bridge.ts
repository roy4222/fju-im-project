import type { Participants, SignoffState } from '@/application/signoff/version'
import type { ConsentSkipReason } from '@/application/signoff/ports'

/**
 * 同意書作業 ↔ 簽核包橋接的純規則（C 階段規格① §1.2、§3.1、§3.3、§6.4；C1-03）。
 *
 * - 發布同意書作業＝每個對象組建包＋第 1 版；沒有主指導或沒有組員的組**跳過**（回 `skipped`，之後由系辦按「建立」補建）。
 * - 最終文件授權：任一對象組沒有成果展示草稿 → **整筆拒絕**（列出組別），和「缺老師＝跳過」分清楚。
 * - 內容或附件改版：收集中、等老師、已完成、退回修正中的包都建新版（舊版 `superseded`、cause `content_change`）；
 *   已失效、已作廢的不動。新版只發 `signoff.content_changed` 給被取代那一版的全部參與者，不發 `version_created`。
 * - 對象減組：該組目前版本作廢，理由固定「系辦移出對象」。
 */

/** 這一組此刻能不能建包；不能就是為什麼（先看老師：畫面上的「尚未建立：沒有指導老師」）。 */
export function consentSkipReason(facts: { readonly memberCount: number; readonly hasAdvisor: boolean }): ConsentSkipReason | null {
  if (!facts.hasAdvisor) return 'no_advisor'
  if (facts.memberCount === 0) return 'no_members'
  return null
}

/** 最終文件授權缺草稿的拒絕句（表單頂部、hook 的 `VALIDATION_FAILED` 同一句）。 */
export function describeMissingDrafts(groupCodes: readonly string[]): string {
  return `這些組還沒有成果展示草稿：${groupCodes.join('、')}`
}

/** 內容改版時這個狀態的目前版本要不要建新版（§1.2：收集中、等老師、已完成、退回修正中都要；已失效、已作廢不動）。 */
export function rebuildsOnContentChange(state: SignoffState): boolean {
  return state === 'collecting' || state === 'teacher_pending' || state === 'complete' || state === 'revision'
}

/** `signoff.content_changed` 的收件人＝被取代那一版快照裡的全部學生＋主指導（含已同意的人：舊同意不計入新版）。 */
export function contentChangedRecipients(previous: Participants): string[] {
  return [...new Set([...previous.students.map((s) => s.userId), previous.advisor.userId])].filter((id) => id !== '')
}

/** 對象減組時作廢版本的理由（進稽核與事件 payload；狀態 `cause` 仍是固定代碼 `void`）。 */
export const GROUP_REMOVED_REASON = '系辦移出對象'

/** `signoff.content_changed` 通知標題（學生、老師端不寫版本號：AC-22）。 */
export function contentChangedTitle(groupCode: string, purposeLabel: string): string {
  return `${groupCode}「${purposeLabel}」同意書內容已更新，請重新閱讀並同意`
}
