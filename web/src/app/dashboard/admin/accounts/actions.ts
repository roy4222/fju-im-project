'use server'
import { headers } from 'next/headers'
import { revalidatePath } from 'next/cache'
import type {
  BulkDisableReceipt,
  BulkPreview,
  DecisionReceipt,
  RosterImportReceipt,
  RosterPreview,
  RosterUploadTicket,
  StatusChangeReceipt,
} from '@/application/accounts'
import {
  BULK_MAX_CHARS,
  getAccountCommand,
  getRegistrationCommand,
  getRosterCommand,
  resolveActor,
} from '@/composition/accounts'
import type { Result } from '@/shared/result'

/**
 * 名單匯入的三個 Server Action（契約 02 §7）。檔案本身**不走** Server Action——
 * 這裡只發 ticket、要預覽、確認匯入；位元組由瀏覽器直接 POST 到 `/api/files/upload`。
 *
 * 授權不在這裡判：每個用例自己再判一次（只有狀態正常的管理員），
 * 直接呼叫這些 action 的人繞不過去。
 */

type ActionOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string; field?: string }

function toOutcome<T>(result: Result<T>): ActionOutcome<T> {
  if (!result.ok) {
    const field = typeof result.details?.field === 'string' ? result.details.field : undefined
    return { ok: false, code: result.code, message: result.message, ...(field ? { field } : {}) }
  }
  return { ok: true, data: result.receipt }
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null
}

export async function startRosterUploadAction(input: {
  fileName: string
  declaredMime: string
  declaredSize: number
}): Promise<ActionOutcome<RosterUploadTicket>> {
  const fileName = text(input?.fileName, 500)
  const declaredMime = text(input?.declaredMime ?? '', 200)
  const declaredSize = typeof input?.declaredSize === 'number' ? input.declaredSize : NaN
  if (fileName === null || declaredMime === null) return { ok: false, code: 'VALIDATION_FAILED', message: '檔案資訊不正確。' }

  const actor = await resolveActor(await headers())
  return toOutcome(await getRosterCommand().startUpload(actor, { fileName, declaredMime, declaredSize }))
}

export async function previewRosterAction(input: {
  fileId: string
  cohortId: string | null
}): Promise<ActionOutcome<RosterPreview>> {
  const fileId = text(input?.fileId, 100)
  const cohortId = input?.cohortId === null ? null : text(input?.cohortId, 100)
  if (!fileId) return { ok: false, code: 'VALIDATION_FAILED', message: '請重新選擇檔案。' }

  const actor = await resolveActor(await headers())
  return toOutcome(await getRosterCommand().preview(actor, { fileId, cohortId }))
}

export async function importRosterAction(input: {
  fileId: string
  cohortId: string
  requestId: string
}): Promise<ActionOutcome<RosterImportReceipt>> {
  const fileId = text(input?.fileId, 100)
  const cohortId = text(input?.cohortId, 100)
  const requestId = text(input?.requestId, 100)
  if (!fileId || !cohortId || !requestId) return { ok: false, code: 'VALIDATION_FAILED', message: '請選擇要匯入的屆別。' }

  const actor = await resolveActor(await headers())
  const outcome = toOutcome(await getRosterCommand().importRoster(actor, { fileId, cohortId, requestId }))
  if (outcome.ok) revalidatePath('/dashboard/admin/accounts')
  return outcome
}

// ── 註冊審核（票 7） ─────────────────────────────────────────────────────────
//
// 授權、欄位規則、版本檢查都在用例裡（只有狀態正常的管理員；核實方式必選；
// 學生改過資料就 CONFLICT）。這裡只把輸入收成正確的型別。

function revisionOf(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : NaN
}

export async function approveRegistrationAction(input: {
  applicationId: string
  revision: number
  verificationMethod: string
  verificationNote: string
  reason: string
  cohortId: string | null
  requestId: string
}): Promise<ActionOutcome<DecisionReceipt>> {
  const applicationId = text(input?.applicationId, 100) ?? ''
  const requestId = text(input?.requestId, 100) ?? ''
  const verificationMethod = text(input?.verificationMethod ?? '', 50) ?? ''
  const verificationNote = text(input?.verificationNote ?? '', 2000)
  const reason = text(input?.reason ?? '', 2000)
  const cohortId = input?.cohortId === null || input?.cohortId === '' ? null : text(input?.cohortId, 100)
  if (verificationNote === null || reason === null) {
    return { ok: false, code: 'VALIDATION_FAILED', message: '說明或理由太長了。' }
  }

  const actor = await resolveActor(await headers())
  const outcome = toOutcome(
    await getRegistrationCommand().approve(actor, {
      applicationId,
      revision: revisionOf(input?.revision),
      verificationMethod,
      verificationNote,
      reason,
      cohortId: cohortId ?? null,
      requestId,
    }),
  )
  // 不在這裡 revalidate：對話框要先顯示回執，關掉後才由畫面自己刷新清單。
  return outcome
}

export async function rejectRegistrationAction(input: {
  applicationId: string
  revision: number
  reason: string
  requestId: string
}): Promise<ActionOutcome<DecisionReceipt>> {
  const applicationId = text(input?.applicationId, 100) ?? ''
  const requestId = text(input?.requestId, 100) ?? ''
  const reason = text(input?.reason ?? '', 2000)
  if (reason === null) return { ok: false, code: 'VALIDATION_FAILED', message: '理由太長了。' }

  const actor = await resolveActor(await headers())
  const outcome = toOutcome(
    await getRegistrationCommand().reject(actor, {
      applicationId,
      revision: revisionOf(input?.revision),
      reason,
      requestId,
    }),
  )
  return outcome
}

// ── 帳號停用／恢復與批次停用（票 9） ─────────────────────────────────────────
//
// 授權、理由必填、不可停用自己、狀態檢查都在用例裡。發動者的 headers 一路帶進去：
// commit 之後撤 session 要以這位管理員的身分呼叫 Better Auth（見 wrapper 的說明）。

export async function disableAccountAction(input: {
  userId: string
  reason: string
  requestId: string
}): Promise<ActionOutcome<StatusChangeReceipt>> {
  const requestHeaders = await headers()
  const actor = await resolveActor(requestHeaders)
  return toOutcome(
    await getAccountCommand().disable(
      actor,
      {
        userId: text(input?.userId, 100) ?? '',
        reason: text(input?.reason ?? '', 2000) ?? '\u0000',
        requestId: text(input?.requestId, 100) ?? '',
      },
      { headers: requestHeaders },
    ),
  )
}

export async function restoreAccountAction(input: {
  userId: string
  reason: string
  requestId: string
}): Promise<ActionOutcome<StatusChangeReceipt>> {
  const requestHeaders = await headers()
  const actor = await resolveActor(requestHeaders)
  return toOutcome(
    await getAccountCommand().restore(
      actor,
      {
        userId: text(input?.userId, 100) ?? '',
        reason: text(input?.reason ?? '', 2000) ?? '\u0000',
        requestId: text(input?.requestId, 100) ?? '',
      },
      { headers: requestHeaders },
    ),
  )
}

export async function previewBulkDisableAction(input: { text: string }): Promise<ActionOutcome<BulkPreview>> {
  const body = text(input?.text ?? '', BULK_MAX_CHARS)
  if (body === null) return { ok: false, code: 'VALIDATION_FAILED', message: '檔案太大了，請分批處理。' }
  const actor = await resolveActor(await headers())
  return toOutcome(await getAccountCommand().previewBulkDisable(actor, body))
}

export async function bulkDisableAction(input: {
  text: string
  expectedUserIds: string[]
  reason: string
  requestId: string
}): Promise<ActionOutcome<BulkDisableReceipt>> {
  const body = text(input?.text ?? '', BULK_MAX_CHARS)
  if (body === null) return { ok: false, code: 'VALIDATION_FAILED', message: '檔案太大了，請分批處理。' }
  const expectedUserIds = Array.isArray(input?.expectedUserIds)
    ? input.expectedUserIds.filter((id): id is string => typeof id === 'string').slice(0, 5000)
    : []
  const requestHeaders = await headers()
  const actor = await resolveActor(requestHeaders)
  return toOutcome(
    await getAccountCommand().bulkDisable(
      actor,
      {
        text: body,
        expectedUserIds,
        reason: text(input?.reason ?? '', 2000) ?? '\u0000',
        requestId: text(input?.requestId, 100) ?? '',
      },
      { headers: requestHeaders },
    ),
  )
}
