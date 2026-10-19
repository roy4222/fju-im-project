'use server'
import { refresh } from 'next/cache'
import { currentActor } from '@/app/_ui/guard'
import { getFileAdminCommand } from '@/composition/files'

/**
 * 檔案分頁「刪除」的 Server Action（C1-16；AC-15）。
 *
 * 授權（只有狀態正常的系辦）與「還有沒有地方在用」都在命令裡判（`deleteUnreferenced`，交易裡鎖列重查），
 * 畫面上 disabled 的按鈕被硬按、或直接呼叫這裡，一樣回 `CONFLICT`、檔案不動。
 */

export type DeleteFileOutcome = { ok: true } | { ok: false; code: string; message: string }

export async function deleteFileAction(input: { fileId: string; requestId: string }): Promise<DeleteFileOutcome> {
  const fileId = typeof input?.fileId === 'string' && input.fileId.length <= 100 ? input.fileId : ''
  const requestId = typeof input?.requestId === 'string' && input.requestId.length <= 100 ? input.requestId : ''
  const result = await getFileAdminCommand().deleteUnreferenced(await currentActor(), fileId, requestId)
  if (!result.ok) return { ok: false, code: result.code, message: result.message }
  refresh()
  return { ok: true }
}
