import 'server-only'
import type { ItemCommand, ItemQuery } from '@/application/items'
import { getBusinessClock } from '@/composition/cohorts'
import { getDueWorkScheduler, getEventPublisher } from '@/composition/notifications'
import { getAuditWriter, getFileStorage, getOperationLedger } from '@/composition/ops'
import { NoResponsesYet } from '@/infrastructure/items/no-responses-yet'
import { PgItemCommand, PgItemQuery } from '@/infrastructure/items/pg-items'

/** 模組 04 專題事務的實例組裝（票 15：建立、編輯、發布、發布更新）。 */
let itemCommand: ItemCommand | undefined
let itemQuery: ItemQuery | undefined

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

/** app 對 application 只能帶型別；畫面要用的標籤、檢查與回饋句子經這裡拿（母 spec §4.3）。 */
export {
  AUDIENCE_LABEL,
  COLLECTION_AUDIENCES,
  collectsResponses,
  describeDeadline,
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
