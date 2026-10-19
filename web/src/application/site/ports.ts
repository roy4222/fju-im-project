import type { ResolvedActor } from '@/application/accounts'
import type { DeclaredUpload, UploadTicket } from '@/application/ops'
import type { HomeSettings, HomeSettingsInput } from '@/application/site/home-settings'
import type { SiteTextInput, SiteTextKey, SiteTexts } from '@/application/site/site-texts'
import type { Result } from '@/shared/result'

/**
 * 首頁設定的 port（第三波 W3；設計方案 §3）。
 *
 * 寫入只有管理員（授權在實作裡判）；讀取是公開的（首頁每次請求都讀，訪客也一樣）。
 * 存了就生效（Q32）：沒有草稿、沒有發布步驟。
 */

export type HomeSettingsReceipt = {
  /** 存完之後的設定版本（樂觀鎖用）。 */
  readonly revision: number
  /** 這次是「恢復預設」（四欄清成 null）。 */
  readonly reset: boolean
  readonly heroChanged: boolean
}

export type HomeSettingsSaveInput = HomeSettingsInput & {
  /** 畫面看到的設定版本；還沒有設定列時是 0。別人先存過就 `CONFLICT`。 */
  readonly revision: number
}

export interface HomeSettingsCommand {
  /** 存四欄；換圖時新圖必須是本人剛上傳的首頁大圖。版本不符 → `CONFLICT`。 */
  save(actor: ResolvedActor, input: HomeSettingsSaveInput, requestId: string): Promise<Result<HomeSettingsReceipt>>
  /** 恢復預設：把四欄清成 null（不刪列）。版本不符 → `CONFLICT`。 */
  reset(actor: ResolvedActor, input: { readonly revision: number }, requestId: string): Promise<Result<HomeSettingsReceipt>>
  /** 首頁大圖的上傳憑證（只收 PNG／JPG、5 MiB）。 */
  requestHeroUpload(actor: ResolvedActor, input: DeclaredUpload): Promise<Result<UploadTicket>>
}

export interface HomeSettingsQuery {
  /** 目前的設定；還沒存過回 null。 */
  current(): Promise<HomeSettings | null>
}

/**
 * 站內文字的 port（C 階段規格② §6.5；C2-17）：頁尾聯絡、三張卡、隱私權政策。
 *
 * 寫入只有系辦（授權在實作裡判）；讀取是公開的（每個前台頁都讀，訪客也一樣，一次讀全部 key）。
 * 存了就生效；`revision` 樂觀鎖沿用首頁設定那套（還沒有列時畫面帶 0）。
 */

export type SiteTextReceipt = {
  readonly key: SiteTextKey
  /** 存完之後的版本（樂觀鎖用）。 */
  readonly revision: number
}

export interface SiteTextsCommand {
  /** 存一個 key 的文字；表單原始值在這裡收斂（`normalizeSiteText`）。版本不符 → `CONFLICT`。 */
  save(actor: ResolvedActor, key: SiteTextKey, value: SiteTextInput, revision: number, requestId: string): Promise<Result<SiteTextReceipt>>
}

export interface SiteTextsQuery {
  /** 全部站內文字（照 key 取；沒存過的 key 不在裡面）。 */
  all(): Promise<SiteTexts>
}
