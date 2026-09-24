import 'server-only'
import type { ResolvedActor } from '@/application/accounts'
import type { DeclaredUpload, UploadTicket } from '@/application/ops'
import type { RosterQuery, SubmissionCommand, SubmissionQuery } from '@/application/submissions'
import { getBusinessClock } from '@/composition/cohorts'
import { getEventPublisher } from '@/composition/notifications'
import { getAuditWriter, getFileStorage, getOperationLedger } from '@/composition/ops'
import { PgRosterQuery } from '@/infrastructure/submissions/pg-roster'
import { PgSubmissionCommand, PgSubmissionQuery } from '@/infrastructure/submissions/pg-submissions'
import { createRateLimiter, type RateLimiter } from '@/shared/rate-limit'
import type { Result } from '@/shared/result'

/**
 * 模組 05 個人與組別繳交的實例組裝（票 17：個人填報、存草稿、正式送出、自己的版本；票 18：收件名單頁；
 * 票 21：組別共用草稿、上傳、代表全組送出與通知）。繳交附件的下載政策登記在 `composition/ops.ts`。
 */
let submissionCommand: SubmissionCommand | undefined
let submissionQuery: SubmissionQuery | undefined
let rosterQuery: RosterQuery | undefined

export function getSubmissionCommand(): SubmissionCommand {
  submissionCommand ??= new PgSubmissionCommand({
    audit: getAuditWriter(),
    ledger: getOperationLedger(),
    businessClock: getBusinessClock(),
    files: getFileStorage(),
    events: getEventPublisher(),
  })
  return submissionCommand
}

export function getSubmissionQuery(): SubmissionQuery {
  submissionQuery ??= new PgSubmissionQuery()
  return submissionQuery
}

/**
 * 繳交上傳憑證限速（契約 03 §6；票 21）。每張憑證都會先建一筆 `uploading` 檔案列，回收工作要到 S12 才上，
 * 所以學生端不能無限要：跟 `/api/files/upload` 同一個額度（20 次／10 分鐘／使用者），兩道各算各的。
 */
const uploadTicketLimiter = createRateLimiter({ max: 20, windowMs: 10 * 60 * 1000 })

export type UploadTicketOutcome =
  | Result<UploadTicket>
  | { readonly ok: false; readonly code: 'RATE_LIMITED'; readonly message: string; readonly retryAfterMs: number }

/** 作業區的「要上傳憑證」：先限速，再交給用例（名單、組員、開放、欄位規則）。 */
export async function requestSubmissionUpload(
  actor: ResolvedActor,
  itemId: string,
  fieldKey: string,
  declared: DeclaredUpload,
  deps: { command?: Pick<SubmissionCommand, 'requestUpload'>; limiter?: RateLimiter } = {},
): Promise<UploadTicketOutcome> {
  if (actor.kind === 'authenticated') {
    const verdict = (deps.limiter ?? uploadTicketLimiter).hit(actor.userId)
    if (!verdict.allowed) {
      return { ok: false, code: 'RATE_LIMITED', message: '上傳太頻繁，請稍後再試。', retryAfterMs: verdict.retryAfterMs }
    }
  }
  return (deps.command ?? getSubmissionCommand()).requestUpload(actor, itemId, fieldKey, declared)
}

export function getRosterQuery(): RosterQuery {
  rosterQuery ??= new PgRosterQuery()
  return rosterQuery
}

/** app 對 application 只能帶型別；畫面要用的狀態字、檢查與回執句子經這裡拿（母 spec §4.3）。 */
export {
  answerFields,
  categoryOf,
  completionOf,
  describeReceipt,
  isFileField,
  LINE_MAX_LENGTH,
  pendingCount,
  phaseOf,
  receiverStatus,
  statusOf,
  submitIssues,
  TEXTAREA_MAX_LENGTH,
} from '@/application/submissions'
