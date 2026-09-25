import 'server-only'
import type { PoolClient } from 'pg'
import type { SignoffCommand, SignoffParticipantHook, SignoffQuery } from '@/application/signoff'
import { getBusinessClock } from '@/composition/cohorts'
import { getEventPublisher } from '@/composition/notifications'
import { getAuditWriter, getFileStorage, getOperationLedger } from '@/composition/ops'
import { PgSignoffCommand, PgSignoffQuery } from '@/infrastructure/signoff/pg-signoff'

/**
 * 模組 07 線上簽核的實例組裝（票 25：建版、參與者變更時的失效、三角色讀取；票 26：表態、重置、重開、作廢、提醒、匯出）。
 *
 * `getSignoffParticipantHook` 給 `composition/groups.ts` 注入分組的組員異動用例：成員集合改變時同一筆交易讓目前簽核版本失效。
 * 這裡不 import 分組的 composition（不會繞成循環）。
 */
let signoffCommand: PgSignoffCommand | undefined
let signoffQuery: SignoffQuery | undefined

function command(): PgSignoffCommand {
  signoffCommand ??= new PgSignoffCommand({
    audit: getAuditWriter(),
    ledger: getOperationLedger(),
    events: getEventPublisher(),
    files: getFileStorage(),
    businessClock: getBusinessClock(),
  })
  return signoffCommand
}

export function getSignoffCommand(): SignoffCommand {
  return command()
}

export function getSignoffParticipantHook(): SignoffParticipantHook<PoolClient> {
  return command()
}

export function getSignoffQuery(): SignoffQuery {
  signoffQuery ??= new PgSignoffQuery()
  return signoffQuery
}

/** app 對 application 只能帶型別；畫面要用的標籤與回饋句子經這裡拿（母 spec §4.3）。 */
export {
  ACCEPTANCE_NOTICE,
  BUTTON_TEXT,
  describeCause,
  describeCreateVersionReceipt,
  describeRemindReceipt,
  describeRespondReceipt,
  describeRestartReceipt,
  describeVoidReceipt,
  isTerminal,
  MAX_ATTACHMENTS,
  MAX_REASON_CHARS,
  nextRemindAt,
  PURPOSE_LABEL,
  RESTART_LABEL,
  restartKindFor,
  SIGNOFF_PURPOSES,
  STATE_LABEL,
  VOTE_RESULT_LABEL,
} from '@/application/signoff'
