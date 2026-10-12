import type { ResolvedActor } from '@/application/accounts'
import type { DeclaredUpload, UploadTicket } from '@/application/ops'
import type { HomeSettings, HomeSettingsInput } from '@/application/site/home-settings'
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
