import 'server-only'
import type { Pool, PoolClient } from 'pg'
import type { ResponsePresence } from '@/application/items'
import { getPool } from '@/infrastructure/db/client'

/**
 * 「這份收件有沒有人作答」（模組實作設計 05 §5 `SubmissionQuery.hasAnyResponse`；票 15 留的接點，票 17 接上）。
 *
 * 有任何一份草稿或正式版本就算「有人作答」：草稿是照目前欄位版本填的，切換收件單位、改對象或改欄位結構，
 * 那份草稿就對不上了，所以存過草稿也要鎖（產品模組 05 §4.6「有回答後不能切換」）。
 *
 * 在發布更新的交易裡呼叫（吃呼叫端的 `tx`）：學生存草稿時對項目拿 `FOR SHARE`、管理員發布更新拿 `FOR UPDATE`，
 * 兩邊排隊，所以不會出現「管理員看的時候還沒人作答、一轉身學生已經存了舊單位的草稿」。
 *
 * **完全空白的草稿不算**（票 18，票 17 審查建議）：學生打開頁面什麼都沒填就按「存草稿」或「正式送出」
 * （送出前會先存一次，接著被必填擋下），會留下一份 `answers = {}`、沒有附件的草稿。那份草稿裡沒有任何
 * 會跟新的收件單位或新欄位對不上的內容，拿它鎖住收件單位只會讓管理員卡住。有填任何一欄或附上檔案才算作答。
 * （空白草稿留著無害：之後學生再存，會照當時的欄位版本重寫；欄位改版後直接送出會被要求重新載入。）
 */

const HAS_RESPONSE = `
  select exists (select 1 from submission_drafts
                  where item_id = $1 and (answers <> '{}'::jsonb or cardinality(file_ids) > 0))
      or exists (select 1 from submission_versions where item_id = $1) as has_response`

export class PgResponsePresence implements ResponsePresence<PoolClient> {
  async hasAnyResponse(tx: PoolClient, itemId: string): Promise<boolean> {
    const found = await tx.query<{ has_response: boolean }>(HAS_RESPONSE, [itemId])
    return found.rows[0]?.has_response === true
  }
}

/** 編輯器畫面用（不在交易裡）：管理員打開已有人作答的收件時，收件單位直接顯示為鎖定。 */
export function responsePresenceReader(reader: () => Pick<Pool, 'query'> = getPool) {
  return {
    async hasAnyResponse(itemId: string): Promise<boolean> {
      const found = await reader().query<{ has_response: boolean }>(HAS_RESPONSE, [itemId])
      return found.rows[0]?.has_response === true
    },
  }
}
