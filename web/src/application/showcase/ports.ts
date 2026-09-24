import type { ResolvedActor } from '@/application/accounts'
import type { DeclaredUpload, UploadTicket } from '@/application/ops'
import type { Result } from '@/shared/result'

/**
 * 模組 09 精選的 port（模組實作設計 09 §5 `ShowcaseCommand`；票 25 只交付最小草稿能力：建立、編輯、海報上傳）。
 *
 * 發布、撤稿、素材核閱、外部授權登記、公開頁都在 S12。授權都在實作裡判：只有管理員（契約 03 §1「精選：admin」）；
 * 學生、老師呼叫任何一個都是 `FORBIDDEN`。
 */

// ── 回執 ────────────────────────────────────────────────────────────────────

export type CreateDraftReceipt = {
  readonly entryId: string
  readonly groupCode: string
  /** 草稿版本（樂觀鎖用；新建是 1）。 */
  readonly revision: number
}

export type UpdateDraftReceipt = {
  readonly entryId: string
  readonly groupCode: string
  readonly revision: number
  readonly posterChanged: boolean
}

// ── 輸入 ────────────────────────────────────────────────────────────────────

export type UpdateDraftInput = {
  readonly entryId: string
  /** 畫面看到的草稿版本；別人先存過就 `CONFLICT`。 */
  readonly revision: number
  readonly title: string
  readonly summary: string
  readonly videoUrl: string
  /** 海報檔（剛上傳的或原本那一張）；null＝拿掉海報。 */
  readonly posterFileId: string | null
}

export type PosterUploadInput = DeclaredUpload & { readonly entryId: string }

// ── 查詢結果 ────────────────────────────────────────────────────────────────

export type ShowcaseDraftView = {
  readonly entryId: string
  readonly groupId: string
  readonly groupCode: string
  readonly groupDissolved: boolean
  readonly status: 'draft' | 'published' | 'withdrawn'
  readonly title: string
  readonly summary: string
  readonly videoUrl: string | null
  readonly poster: { readonly fileId: string; readonly name: string; readonly checksum: string } | null
  readonly revision: number
  readonly updatedAt: Date
  readonly updatedByName: string | null
  /** 有幾個簽核版本的授權範圍是從這份草稿凍結的（只是提示：改草稿不會影響已凍結的版本）。 */
  readonly frozenInVersions: number
}

export type ShowcaseBoard = {
  readonly cohort: { readonly id: string; readonly code: string; readonly archived: boolean }
  /** 這一屆有效（沒解散）的組別，以及它有沒有草稿。 */
  readonly groups: readonly { readonly id: string; readonly code: string; readonly entryId: string | null }[]
  readonly drafts: readonly ShowcaseDraftView[]
}

// ── port ────────────────────────────────────────────────────────────────────

export interface ShowcaseCommand {
  /** 替一組建精選條目＋空草稿（同交易）。同屆同組已經有 → `CONFLICT`；組別解散 → `GROUP_DISSOLVED`。 */
  createDraft(actor: ResolvedActor, input: { groupId: string }, requestId: string): Promise<Result<CreateDraftReceipt>>
  /** 存草稿：題目、摘要、影片連結、海報。草稿版本不符 → `CONFLICT`；海報不是本人剛上傳的圖片 → `FILE_*`。 */
  updateDraft(actor: ResolvedActor, input: UpdateDraftInput, requestId: string): Promise<Result<UpdateDraftReceipt>>
  /** 替某份草稿要一張海報上傳憑證（只收 PNG／JPG）。 */
  requestPosterUpload(actor: ResolvedActor, input: PosterUploadInput): Promise<Result<UploadTicket>>
}

export interface ShowcaseQuery {
  /** 管理員的精選頁；不是管理員 → `FORBIDDEN`。 */
  adminBoard(actor: ResolvedActor, cohortId: string): Promise<Result<ShowcaseBoard>>
}
