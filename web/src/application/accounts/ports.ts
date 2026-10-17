import type { ResolvedActor } from '@/application/accounts/actor'
import type { AvatarChoice } from '@/application/accounts/avatar'
import type { DeclaredUpload, UploadTicket } from '@/application/ops'
import type { Result } from '@/shared/result'

/**
 * 模組 01 對外提供的 port（模組 01 §5）。
 *
 * 實作在 infrastructure，實例由 composition 注入——用例只看得到這個介面。
 */
export interface ActorResolver {
  /** 從這次請求的 headers（cookie 在裡面）算出現在是誰。 */
  resolve(headers: Headers): Promise<ResolvedActor>
}

/**
 * 頭像用例（SH-9；B 設計方案 §2.2.1）。獨立於 `AccountCommand`，實作在 `infrastructure/accounts/avatar-store.ts`，
 * 由 `composition/avatars.ts` 組裝。畫面掛載在「我的帳號」（VB-10）與系辦帳號列表（AD-B2）。
 */
export interface AvatarCommand {
  /** 本人換頭像：預設圖或已上傳完成的 avatar 檔。舊的上傳檔同一交易標刪（Q109）；寫 audit `account.avatar_update`。 */
  updateAvatar(actor: ResolvedActor, input: AvatarChoice): Promise<Result<void>>
  /** 只有系辦；reason 去頭尾空白後 1～200 字；兩欄清成 null、舊檔標刪；寫 audit `account.avatar_reset`。 */
  resetAvatar(actor: ResolvedActor, userId: string, reason: string): Promise<Result<void>>
  /** 發上傳票券：purpose 'avatar'、scope global、ownerUserId = actor.userId；收 PNG／JPG／WebP、2 MiB。 */
  avatarUploadTicket(actor: ResolvedActor, input: DeclaredUpload): Promise<Result<UploadTicket>>
}
