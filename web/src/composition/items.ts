import 'server-only'
import type { ItemCommand, ItemQuery, PublicItemQuery } from '@/application/items'
import { getBusinessClock } from '@/composition/cohorts'
import { getDueWorkScheduler, getEventPublisher } from '@/composition/notifications'
import { getAuditWriter, getFileStorage, getOperationLedger } from '@/composition/ops'
import { NoResponsesYet } from '@/infrastructure/items/no-responses-yet'
import { PgItemCommand, PgItemQuery } from '@/infrastructure/items/pg-items'
import { PgPublicItemQuery } from '@/infrastructure/items/pg-public-items'

/** 模組 04 專題事務的實例組裝（票 15：建立、編輯、發布、發布更新；票 16：撤回、下架、重新發布、前台查詢）。 */
let itemCommand: ItemCommand | undefined
let itemQuery: ItemQuery | undefined
let publicItemQuery: PublicItemQuery | undefined

export function getItemCommand(): ItemCommand {
  itemCommand ??= new PgItemCommand({
    audit: getAuditWriter(),
    ledger: getOperationLedger(),
    events: getEventPublisher(),
    dueWork: getDueWorkScheduler(),
    files: getFileStorage(),
    // 回答表在票 17；在那之前一律「沒有人作答」（見 NoResponsesYet 的說明）。
    responses: new NoResponsesYet(),
    businessClock: getBusinessClock(),
  })
  return itemCommand
}

export function getItemQuery(): ItemQuery {
  itemQuery ??= new PgItemQuery()
  return itemQuery
}

/** 前台內容頁與學生日曆：自己依看的人過濾（頁面不用再守門，但也不能繞過它自己查表）。 */
export function getPublicItemQuery(): PublicItemQuery {
  publicItemQuery ??= new PgPublicItemQuery()
  return publicItemQuery
}

/** app 對 application 只能帶型別；畫面要用的標籤、檢查與回饋句子經這裡拿（母 spec §4.3）。 */
export {
  AUDIENCE_LABEL,
  COLLECTION_AUDIENCES,
  collectsResponses,
  describeDeadline,
  describeLifecycleReceipt,
  describePublishReceipt,
  describeUpdateReceipt,
  EDITABLE_PLACEMENTS,
  EMPTY_COLLECTION_MESSAGE,
  FIELD_TYPE_LABEL,
  FIELD_TYPES,
  FILE_FIELD_MAX_MIB,
  INPUT_FIELD_TYPES,
  ITEM_STATUS_LABEL,
  ITEM_UPLOAD,
  LIFECYCLE_LABEL,
  MAX_ATTACHMENTS,
  MAX_FIELDS,
  PLACEMENT_HINT,
  PLACEMENT_LABEL,
  publishChecks,
  RECEIVER_UNIT_LABEL,
  renderBodyHtml,
  SUBMISSION_FILE_TYPES,
  SUMMARY_MAX_LENGTH,
  TITLE_MAX_LENGTH,
} from '@/application/items'
