'use server'
import { refresh } from 'next/cache'
import { currentActor } from '@/app/_ui/guard'
import type { ImportActionOutcome } from '@/app/dashboard/admin/groups/import-dialog'
import type { GroupImportPreview, GroupImportReceipt, GroupImportUploadTicket } from '@/application/groups'
import { describeGroupImportReceipt, getGroupImportCommand, groupImportResultCsv } from '@/composition/groups'
import type { Result } from '@/shared/result'

// 系辦匯入分組（C3-16）：檔案本身不走 Server Action（位元組由瀏覽器直接 POST 到 `/api/files/upload`，同批次指派）；
// 這裡只發 ticket、要預覽、確認執行。授權與所有規則都在用例裡。

function field(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null
}

function outcome<T>(result: Result<T>): ImportActionOutcome<T> {
  return result.ok ? { ok: true, data: result.receipt } : { ok: false, message: result.message }
}

export async function startGroupImportUploadAction(input: {
  fileName: string
  declaredMime: string
  declaredSize: number
}): Promise<ImportActionOutcome<GroupImportUploadTicket>> {
  const fileName = field(input?.fileName, 500)
  const declaredMime = field(input?.declaredMime ?? '', 200)
  const declaredSize = typeof input?.declaredSize === 'number' ? input.declaredSize : Number.NaN
  if (fileName === null || declaredMime === null) return { ok: false, message: '檔案資訊不正確。' }
  return outcome(await getGroupImportCommand().startUpload(await currentActor(), { fileName, declaredMime, declaredSize }))
}

export async function previewGroupImportAction(input: { fileId: string; cohortId: string }): Promise<ImportActionOutcome<GroupImportPreview>> {
  const fileId = field(input?.fileId, 100)
  const cohortId = field(input?.cohortId, 100)
  if (!fileId || !cohortId) return { ok: false, message: '請重新選擇檔案。' }
  return outcome(await getGroupImportCommand().preview(await currentActor(), { fileId, cohortId }))
}

export async function executeGroupImportAction(input: {
  fileId: string
  cohortId: string
  requestId: string
}): Promise<ImportActionOutcome<{ receipt: GroupImportReceipt; message: string; csv: string }>> {
  const fileId = field(input?.fileId, 100)
  const cohortId = field(input?.cohortId, 100)
  const requestId = field(input?.requestId, 100)
  if (!fileId || !cohortId || !requestId) return { ok: false, message: '請重新上傳檔案。' }
  const result = await getGroupImportCommand().execute(await currentActor(), { fileId, cohortId }, requestId)
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return {
    ok: true,
    data: { receipt: result.receipt, message: describeGroupImportReceipt(result.receipt), csv: groupImportResultCsv(result.receipt) },
  }
}
