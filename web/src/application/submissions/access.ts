/**
 * 誰能讀一份繳交（與它的附件）——純規則（契約 03 §1 授權矩陣的「組別共用草稿」「組別正式版本」「個人回答」三列；
 * 產品模組 05 §4「誰看得到個人回答」§8「其他角色所見」；票 21）。
 *
 * 附件下載每次都經這裡（`/api/files/[id]` → 下載政策 → 這個函式），所以網址直接打也是同一群人。
 * 事實由 infrastructure 每次重查（此刻有效的組員、目前主指導、最新的閱覽設定），這裡不快取、也不看歷史關係。
 *
 * - 管理員：都可以。
 * - 草稿（組別共用草稿、個人草稿）：個人＝本人；組別＝**此刻**有效組員。老師一律不行（主指導只看正式版本）。
 * - 正式版本：
 *   - 個人：本人；主指導只在「這份收件目前開放主指導閱覽、這一版的欄位版本 ≥ 生效版本、他是本人目前組別的主指導」時可以。
 *   - 組別：此刻有效組員；該組**目前**主指導（換老師後舊老師就不行，契約 03 §1）；
 *     以及**送出當下在組裡**的人（`membership_snapshot`，票 22）：被移出的人只讀得到自己還在組裡時送出的版本，
 *     移出之後組裡再送的版本拿不到（契約 03 §1「被移出／解散後：本人唯讀自己的正式版本」；產品模組 05 SUB-20、25）。
 * - 受指派評分老師：第四站（評分）再接，這裡先一律拒絕。
 */

export type SubmissionViewer = {
  readonly userId: string
  readonly isAdmin: boolean
  readonly isTeacher: boolean
  /** 此刻有效（`valid_to IS NULL`、組別未解散）的組別。 */
  readonly memberOfGroupIds: readonly string[]
}

export type AdvisorVisibility = { readonly enabled: boolean; readonly effectiveFromVersionNo: number }

export type SubmissionHolder =
  | { readonly kind: 'draft'; readonly receiverKind: 'user' | 'group'; readonly receiverId: string }
  | {
      readonly kind: 'version'
      readonly receiverKind: 'user' | 'group'
      readonly receiverId: string
      /** 這一版送出時用的欄位版本號。 */
      readonly schemaVersionNo: number
      /** 組別：該組目前主指導；個人：本人目前組別的主指導。沒有是 null。 */
      readonly currentAdvisorUserId: string | null
      /** 這份收件最新的主指導閱覽設定；沒設過是 null（＝不開放）。只對個人回答有意義。 */
      readonly visibility: AdvisorVisibility | null
      /** 組別：送出當下的有效組員（`membership_snapshot`）；個人是 null。 */
      readonly membershipSnapshot: readonly string[] | null
    }

/** 個人回答的主指導閱覽：設定開著，而且這一版是在生效的欄位版本以後送出的（舊回答不擴權）。 */
export function advisorMayReadIndividual(visibility: AdvisorVisibility | null, schemaVersionNo: number): boolean {
  return visibility !== null && visibility.enabled && schemaVersionNo >= visibility.effectiveFromVersionNo
}

export function canReadSubmission(viewer: SubmissionViewer, holder: SubmissionHolder): boolean {
  if (viewer.isAdmin) return true
  const isReceiver =
    holder.receiverKind === 'user' ? holder.receiverId === viewer.userId : viewer.memberOfGroupIds.includes(holder.receiverId)
  if (isReceiver) return true
  if (holder.kind === 'draft') return false
  // 送出當下在組裡：被移出後仍可唯讀這一版（只看這一版的快照，不看「曾經是組員」）。
  if (holder.receiverKind === 'group' && holder.membershipSnapshot?.includes(viewer.userId)) return true
  if (!viewer.isTeacher || holder.currentAdvisorUserId === null || holder.currentAdvisorUserId !== viewer.userId) return false
  return holder.receiverKind === 'group' || advisorMayReadIndividual(holder.visibility, holder.schemaVersionNo)
}
