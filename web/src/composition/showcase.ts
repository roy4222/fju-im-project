import 'server-only'
import type { PublicShowcaseQuery, ShowcaseCommand, ShowcaseQuery } from '@/application/showcase'
import { getBusinessClock } from '@/composition/cohorts'
import { getAuditWriter, getFileStorage, getOperationLedger } from '@/composition/ops'
import { PgPublicShowcaseQuery } from '@/infrastructure/showcase/pg-public-showcase'
import { PgShowcaseCommand, PgShowcaseQuery } from '@/infrastructure/showcase/pg-showcase'

/**
 * 模組 09 精選的實例組裝（票 25：最小草稿能力——建立、編輯、海報上傳；發布與公開頁在 S12）。
 */
let showcaseCommand: ShowcaseCommand | undefined
let showcaseQuery: ShowcaseQuery | undefined

export function getShowcaseCommand(): ShowcaseCommand {
  showcaseCommand ??= new PgShowcaseCommand({
    audit: getAuditWriter(),
    ledger: getOperationLedger(),
    files: getFileStorage(),
    businessClock: getBusinessClock(),
  })
  return showcaseCommand
}

export function getShowcaseQuery(): ShowcaseQuery {
  showcaseQuery ??= new PgShowcaseQuery()
  return showcaseQuery
}

let publicShowcaseQuery: PublicShowcaseQuery | undefined

/** 前台的優秀專題、歷屆一覽、專題詳情（只讀已發布版本；前台補頁）。 */
export function getPublicShowcaseQuery(): PublicShowcaseQuery {
  publicShowcaseQuery ??= new PgPublicShowcaseQuery()
  return publicShowcaseQuery
}

/** app 對 application 只能帶型別；畫面要用的標籤與回饋句子經這裡拿（母 spec §4.3）。 */
export {
  describeCreateDraftReceipt,
  describeUpdateDraftReceipt,
  GATE_PLACEHOLDER,
  parseShowcaseSort,
  POSTER_UPLOAD,
  SHOWCASE_LIMITS,
  SHOWCASE_SORT_OPTIONS,
} from '@/application/showcase'
