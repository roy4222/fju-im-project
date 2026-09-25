'use server'
import { refresh } from 'next/cache'
import { currentActor } from '@/app/_ui/guard'
import type { ShowcaseActionState } from '@/app/dashboard/admin/showcase/showcase-forms'
import type { UploadTicket } from '@/application/ops'
import { describeCreateDraftReceipt, describeUpdateDraftReceipt, getShowcaseCommand } from '@/composition/showcase'

/**
 * 管理員「精選」頁的動作（票 25／S11-03）：替一組建立精選草稿、存草稿、要海報上傳憑證。
 * 海報的位元組不走 Server Action，由瀏覽器直接 POST 到 `/api/files/upload`（契約 02 §6）。
 * 規則全在用例裡判；這裡只把表單收斂成用例要的形狀、把結果翻成一句話。
 */

const text = (formData: FormData, name: string, max = 200) => String(formData.get(name) ?? '').slice(0, max)

export async function createDraftAction(_state: ShowcaseActionState, formData: FormData): Promise<ShowcaseActionState> {
  const result = await getShowcaseCommand().createDraft(await currentActor(), { groupId: text(formData, 'groupId', 100) }, text(formData, 'requestId'))
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: describeCreateDraftReceipt(result.receipt) }
}

export async function updateDraftAction(_state: ShowcaseActionState, formData: FormData): Promise<ShowcaseActionState> {
  const poster = text(formData, 'posterFileId', 100)
  const result = await getShowcaseCommand().updateDraft(
    await currentActor(),
    {
      entryId: text(formData, 'entryId', 100),
      revision: Number(text(formData, 'revision', 20)),
      // 長度上限由用例判（說得出是多少）；這裡只擋掉離譜的大小。
      title: text(formData, 'title', 2_000),
      summary: text(formData, 'summary', 20_000),
      videoUrl: text(formData, 'videoUrl', 2_000),
      posterFileId: poster === '' ? null : poster,
    },
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: describeUpdateDraftReceipt(result.receipt) }
}

export async function requestPosterUploadAction(input: {
  entryId: string
  fileName: string
  declaredMime: string
  declaredSize: number
}): Promise<{ ok: true; ticket: UploadTicket } | { ok: false; message: string }> {
  const result = await getShowcaseCommand().requestPosterUpload(await currentActor(), {
    entryId: String(input?.entryId ?? '').slice(0, 100),
    fileName: String(input?.fileName ?? '').slice(0, 500),
    declaredMime: String(input?.declaredMime ?? '').slice(0, 200),
    declaredSize: typeof input?.declaredSize === 'number' ? input.declaredSize : Number.NaN,
  })
  if (!result.ok) return { ok: false, message: result.message }
  const { ticket, fileId, maxBytes, expiresAt } = result.receipt
  return { ok: true, ticket: { ticket, fileId, maxBytes, expiresAt } }
}
