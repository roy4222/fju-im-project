/**
 * 模組 09 精選的公開入口（母 spec §4.3）。票 25：最小草稿能力（建立、編輯、海報上傳；不發布）。
 *
 * 跨模組只能從這裡引用，而且只能帶型別；執行期的實作由 composition 注入。
 */
export type { DraftFields, DraftFieldsInput } from '@/application/showcase/draft'
export {
  GATE_PLACEHOLDER,
  normalizeDraftFields,
  normalizeSummary,
  normalizeTitle,
  POSTER_UPLOAD,
  SHOWCASE_LIMITS,
} from '@/application/showcase/draft'
export type {
  CreateDraftReceipt,
  PosterUploadInput,
  PublicShowcaseCard,
  PublicShowcasePage,
  PublicShowcaseQuery,
  ShowcaseArchive,
  ShowcaseListFilter,
  ShowcaseNeighbor,
  ShowcasePeople,
  ShowcaseSort,
  SignedInShowcaseCard,
  ShowcaseBoard,
  ShowcaseCommand,
  ShowcaseDraftView,
  ShowcaseQuery,
  UpdateDraftInput,
  UpdateDraftReceipt,
} from '@/application/showcase/ports'
export {
  parseShowcaseSort,
  SHOWCASE_SORT_OPTIONS,
} from '@/application/showcase/public'
export { describeCreateDraftReceipt, describeUpdateDraftReceipt } from '@/application/showcase/receipts'
