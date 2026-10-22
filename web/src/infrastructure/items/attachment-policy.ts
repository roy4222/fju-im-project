import 'server-only'
import type { Pool } from 'pg'
import type { ResolvedActor } from '@/application/accounts'
import { canViewItem, type AudienceKind, type ItemStatus, type ReceiverUnit } from '@/application/items'
import type { DownloadPolicy } from '@/application/ops'
import { viewerOf } from '@/infrastructure/items/viewer'
import { canReadSignoffVersions } from '@/infrastructure/signoff/version-read-access'

/**
 * 專題事務附件與封面的下載政策（`DOWNLOAD_POLICIES.attachment`；產品模組 04 §4.3、契約 03 §1）。
 *
 * 誰能下載＝誰看得到綁著這個檔案的項目（`canViewItem`）：
 * - 管理員：什麼狀態都可以（編輯與預覽要用）。
 * - 其他人：項目要是發布中，而且自己在對象內（本屆學生、指定組別的成員、全部老師、所有登入者、公開）。
 *   指導老師跟前台同一條規則（第三波 W4）：指導該屆任一組＝看得到「本屆學生」的公告、資源附件（收件的不行）；
 *   指導某組＝看得到「指定組別」含該組、不收件的附件（收件的附件只給組員）。
 * - **訪客**（沒登入、停用、待審、必須改密都算，見 `viewerOf`）：只有發布中、對象是「公開訪客」的項目的附件（票 16）。
 * - 草稿、下架、沒綁任何項目（剛上傳還沒存）的檔案：一律不行。
 * - **已刪除的項目**（第三波 W1）：先把引用過濾成「指向未刪除項目」的有效引用；一個都沒有就對所有身分
 *   **含管理員**拒絕（管理員的提前放行在過濾之後），刪掉的公告附件連管理員都下載不到。
 *
 * 只看**目前有效**的引用（`released_at IS NULL`，由共用檔案能力先篩好）：從項目拿掉的舊附件就下載不到了。
 * 每次下載都重查（契約 03 §4），不快取結果。
 *
 * **站內同意書的附件**（C 階段規格① §3.3，C1-03）：同意書作業發布時，作業附件以 `signoff_version` 引用綁到各組的簽核版本上。
 * 另接受「經簽核版本讀權驗證」的 `signoff_version` 引用：讀得到那一版的人（`canReadSignoffVersions`：管理員、快照裡的學生、
 * 該組此刻的組員與主指導）就下載得到——主指導因此能下載整組收件的同意書附件；系辦換掉附件後，只剩舊版 `signoff_version`
 * 引用的舊檔，系辦與該舊版參與者仍可下載。**不放寬其他附件**：沒有 `item_attachment`、也沒有可讀簽核版本引用的檔照舊拒絕；
 * 非該組參與者的老師對同一檔仍只依 item 對象判斷。訪客、狀態被擋的人（比照訪客）不走簽核這一條。
 * 同意書作業刪除後，這一條**照舊放行**（簽核紀錄的留存性質，CL-14；見下方程式註解）。
 */

type ItemFacts = {
  id: string
  status: ItemStatus
  audience_kind: AudienceKind
  cohort_id: string
  receiver_unit: ReceiverUnit
  group_ids: string[] | null
}

export function createAttachmentPolicy(reader: () => Pick<Pool, 'query'>): DownloadPolicy {
  return async (actor, file) => {
    const itemIds = file.references.filter((r) => r.refType === 'item_attachment').map((r) => r.refId)
    const signoffIds = file.references.filter((r) => r.refType === 'signoff_version').map((r) => r.refId)
    if (itemIds.length === 0 && signoffIds.length === 0) return false

    const db = reader()
    if (itemIds.length > 0 && (await viewableViaItems(db, actor, itemIds))) return true
    // 簽核版本引用：只給登入者，用版本頁同一個讀權判斷（管理員在裡面放行）。
    // **項目已刪除時仍依簽核版本讀權放行**：簽核版本是「同意了什麼」的留存紀錄，連到的作業刪掉，紀錄與附件都留著，
    // 版本頁、學生簽核頁也照樣列得出那一版（CL-14 決定，主腦代定；規格① §3.3「附件來源貫通」）。
    // 一般附件不受影響：上面的 `item_attachment` 引用照舊只算未刪除的項目。
    if (signoffIds.length > 0 && actor.kind === 'authenticated') return canReadSignoffVersions(db, actor, signoffIds)
    return false
  }
}

/** 原本的規則：誰看得到綁著這個檔的（未刪除）項目（管理員任何狀態；其他人看對象）。 */
async function viewableViaItems(db: Pick<Pool, 'query'>, actor: ResolvedActor, itemIds: readonly string[]): Promise<boolean> {
  const items = await db.query<ItemFacts>(
    `select m.id, m.status, m.audience_kind, m.cohort_id, m.receiver_unit,
            array(select a.group_id from item_audience_groups a where a.item_id = m.id) as group_ids
       from managed_items m where m.id = any($1::uuid[]) and m.deleted_at is null`,
    [itemIds],
  )
  if (items.rows.length === 0) return false
  if (actor.kind === 'authenticated' && actor.roles.includes('admin')) return true

  const viewer = await viewerOf(db, actor, {
    needsGroups: items.rows.some((i) => i.audience_kind === 'groups' || i.audience_kind === 'cohort_students'),
  })
  return items.rows.some((i) =>
    canViewItem(viewer, {
      status: i.status,
      audienceKind: i.audience_kind,
      cohortId: i.cohort_id,
      groupIds: i.group_ids ?? [],
      receiverUnit: i.receiver_unit,
    }),
  )
}
