'use server'
import { refresh } from 'next/cache'
import { currentActor } from '@/app/_ui/guard'
import type { GroupImportSettings, ImportActionOutcome } from '@/app/dashboard/admin/groups/import-dialog'
import type { GroupImportPreview, GroupImportReceipt, GroupImportUploadTicket } from '@/application/groups'
import { actorHasRole, checkStatus } from '@/composition/accounts'
import {
  describeGroupImportReceipt,
  getGroupImportCommand,
  GROUP_IMPORT_KIND_LABEL,
  GROUP_IMPORT_MAX_BYTES,
  GROUP_IMPORT_OUTCOME_LABEL,
  groupImportResultCsv,
} from '@/composition/groups'
import type { Result } from '@/shared/result'

// 系辦匯入分組（C3-16）：檔案本身不走 Server Action（位元組由瀏覽器直接 POST 到 `/api/files/upload`，同批次指派）；
// 這裡只發 ticket、要預覽、確認執行。授權與所有規則都在用例裡。
//
// 對外只有一個 Server Action（`groupImportAction`，依 `op` 分派）：用戶端每多一個 Server Action 引用，
// 「全部組別」的首載就多一段打包不掉的 id；對話框本體是按「匯入」才載入的。

function field(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null
}

function outcome<T>(result: Result<T>): ImportActionOutcome<T> {
  return result.ok ? { ok: true, data: result.receipt } : { ok: false, message: result.message }
}

function isAdmin(actor: Awaited<ReturnType<typeof currentActor>>): boolean {
  return actorHasRole(actor, 'admin') && checkStatus(actor, 'business') === null
}

/** 對話框開啟時拿的文字與上限（對話框不進頁面首載，所以不從頁面帶 props）。
 * SEC-2：不碰資料也先過系辦＋business 狀態守門；不過就丟錯，對話框照「連線中斷」處理，不回任何設定。 */
async function settings(): Promise<GroupImportSettings> {
  const actor = await currentActor()
  if (!isAdmin(actor)) throw new Error('只有系辦可以匯入分組。')
  return { kindLabels: GROUP_IMPORT_KIND_LABEL, outcomeLabels: GROUP_IMPORT_OUTCOME_LABEL, maxBytes: GROUP_IMPORT_MAX_BYTES }
}

async function startUpload(input: {
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

async function preview(input: { fileId: string; cohortId: string }): Promise<ImportActionOutcome<GroupImportPreview>> {
  const fileId = field(input?.fileId, 100)
  const cohortId = field(input?.cohortId, 100)
  if (!fileId || !cohortId) return { ok: false, message: '請重新選擇檔案。' }
  return outcome(await getGroupImportCommand().preview(await currentActor(), { fileId, cohortId }))
}

async function execute(input: {
  fileId: string
  cohortId: string
  requestId: string
}): Promise<ImportActionOutcome<ExecuteResult>> {
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

type ExecuteResult = { receipt: GroupImportReceipt; message: string; csv: string }

export async function groupImportAction(request: { op: 'settings' }): Promise<GroupImportSettings>
export async function groupImportAction(request: {
  op: 'upload'
  fileName: string
  declaredMime: string
  declaredSize: number
}): Promise<ImportActionOutcome<GroupImportUploadTicket>>
export async function groupImportAction(request: {
  op: 'preview'
  fileId: string
  cohortId: string
}): Promise<ImportActionOutcome<GroupImportPreview>>
export async function groupImportAction(request: {
  op: 'execute'
  fileId: string
  cohortId: string
  requestId: string
}): Promise<ImportActionOutcome<ExecuteResult>>
export async function groupImportAction(request: { op: string } & Record<string, unknown>): Promise<unknown> {
  switch (request?.op) {
    case 'settings':
      return settings()
    case 'upload':
      return startUpload(request as unknown as Parameters<typeof startUpload>[0])
    case 'preview':
      return preview(request as unknown as Parameters<typeof preview>[0])
    case 'execute':
      return execute(request as unknown as Parameters<typeof execute>[0])
    default:
      return { ok: false, message: '請重新整理頁面再試。' }
  }
}
