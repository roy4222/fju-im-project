/**
 * 模組 09 精選的公開入口（母 spec §4.3）。票 25：草稿（建立、編輯、海報上傳）；第三波 W2：發布、下架、重新發布、獎項、刪除；W15：歷屆補登、首頁順序、發布更新。
 *
 * 跨模組只能從這裡引用，而且只能帶型別；執行期的實作由 composition 注入。
 */
export type { DraftFields, DraftFieldsInput } from '@/application/showcase/draft'
export {
  normalizeDraftFields,
  normalizeSummary,
  normalizeTitle,
  POSTER_UPLOAD,
  SHOWCASE_LIMITS,
} from '@/application/showcase/draft'
export {
  AWARD_LABEL_MAX,
  AWARD_LEVEL_LABEL,
  checkShowcaseLifecycle,
  HOME_POSITION_MAX,
  normalizeAward,
  normalizeHomePosition,
  SHOWCASE_STATUS_LABEL,
} from '@/application/showcase/lifecycle'
export type { ShowcaseLifecycleAction, ShowcaseStatus } from '@/application/showcase/lifecycle'
export type {
  CreateBackfillInput,
  CreateBackfillReceipt,
  CreateDraftReceipt,
  PosterUploadInput,
  PublishInput,
  PublishReceipt,
  SetAwardInput,
  SetAwardReceipt,
  SetHomePositionInput,
  SetHomePositionReceipt,
  ShowcaseBoardFilter,
  ShowcaseEntryRef,
  ShowcaseLifecycleReceipt,
  PublicShowcaseCard,
  PublicShowcasePage,
  PublicShowcaseQuery,
  ShowcaseArchive,
  ShowcaseAward,
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
  ARCHIVE_SORT_OPTIONS,
  FEATURED_SORT_OPTIONS,
  parseShowcaseSort,
} from '@/application/showcase/public'
export {
  describeCreateDraftReceipt,
  describeDeleteReceipt,
  describePublishReceipt,
  describeRepublishReceipt,
  describeSetAwardReceipt,
  describeUpdateDraftReceipt,
  describeWithdrawReceipt,
} from '@/application/showcase/receipts'
