import 'server-only'
import type { PoolClient } from 'pg'
import type { ResponsePresence } from '@/application/items'

/**
 * 票 15 的「有沒有人作答」：回答表（個人草稿、正式送出版本）在票 17 才建，所以一律回 false。
 *
 * 規則已經接好了——`updatePublished` 在同一筆交易裡問這個 port，回 true 就拒絕切換收件單位、
 * 改對象或改欄位結構（`ITEM_HAS_RESPONSES`）；整合測試用回 true 的替身證明。
 * 票 17 建好回答表後，把這個類別換成真的查詢（`drafts`／`submission_versions` 有沒有這個項目的列）。
 */
export class NoResponsesYet implements ResponsePresence<PoolClient> {
  async hasAnyResponse(): Promise<boolean> {
    return false
  }
}
