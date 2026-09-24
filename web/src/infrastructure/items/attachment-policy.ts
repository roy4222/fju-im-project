import 'server-only'
import type { Pool } from 'pg'
import { canViewItem, type AudienceKind, type ItemStatus } from '@/application/items'
import type { DownloadPolicy } from '@/application/ops'
import { viewerOf } from '@/infrastructure/items/viewer'

/**
 * 專題事務附件與封面的下載政策（`DOWNLOAD_POLICIES.attachment`；產品模組 04 §4.3、契約 03 §1）。
 *
 * 誰能下載＝誰看得到綁著這個檔案的項目（`canViewItem`）：
 * - 管理員：什麼狀態都可以（編輯與預覽要用）。
 * - 其他人：項目要是發布中，而且自己在對象內（本屆學生、指定組別的成員、全部老師、所有登入者、公開）。
 * - **訪客**（沒登入、停用、待審、必須改密都算，見 `viewerOf`）：只有發布中、對象是「公開訪客」的項目的附件（票 16）。
 * - 草稿、下架、沒綁任何項目（剛上傳還沒存）的檔案：一律不行。
 *
 * 只看**目前有效**的引用（`released_at IS NULL`，由共用檔案能力先篩好）：從項目拿掉的舊附件就下載不到了。
 * 每次下載都重查（契約 03 §4），不快取結果。
 */

type ItemFacts = { id: string; status: ItemStatus; audience_kind: AudienceKind; cohort_id: string; group_ids: string[] | null }

export function createAttachmentPolicy(reader: () => Pick<Pool, 'query'>): DownloadPolicy {
  return async (actor, file) => {
    const itemIds = file.references.filter((r) => r.refType === 'item_attachment').map((r) => r.refId)
    if (itemIds.length === 0) return false
    if (actor.kind === 'authenticated' && actor.roles.includes('admin')) return true

    const db = reader()
    const items = await db.query<ItemFacts>(
      `select m.id, m.status, m.audience_kind, m.cohort_id,
              array(select a.group_id from item_audience_groups a where a.item_id = m.id) as group_ids
         from managed_items m where m.id = any($1::uuid[])`,
      [itemIds],
    )
    if (items.rows.length === 0) return false

    const viewer = await viewerOf(db, actor, { needsGroups: items.rows.some((i) => i.audience_kind === 'groups') })
    return items.rows.some((i) =>
      canViewItem(viewer, { status: i.status, audienceKind: i.audience_kind, cohortId: i.cohort_id, groupIds: i.group_ids ?? [] }),
    )
  }
}
