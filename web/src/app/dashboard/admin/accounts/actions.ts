'use server'
import { headers } from 'next/headers'
import { revalidatePath } from 'next/cache'
import type { RosterImportReceipt, RosterPreview, RosterUploadTicket } from '@/application/accounts'
import { getRosterCommand, resolveActor } from '@/composition/accounts'
import type { Result } from '@/shared/result'

/**
 * 名單匯入的三個 Server Action（契約 02 §7）。檔案本身**不走** Server Action——
 * 這裡只發 ticket、要預覽、確認匯入；位元組由瀏覽器直接 POST 到 `/api/files/upload`。
 *
 * 授權不在這裡判：每個用例自己再判一次（只有狀態正常的管理員），
 * 直接呼叫這些 action 的人繞不過去。
 */

type ActionOutcome<T> = { ok: true; data: T } | { ok: false; code: string; message: string }

function toOutcome<T>(result: Result<T>): ActionOutcome<T> {
  if (!result.ok) return { ok: false, code: result.code, message: result.message }
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
