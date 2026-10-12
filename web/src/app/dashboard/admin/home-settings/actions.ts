'use server'
import { refresh } from 'next/cache'
import { currentActor } from '@/app/_ui/guard'
import type { HomeSettingsActionState } from '@/app/dashboard/admin/home-settings/home-settings-form'
import type { UploadTicket } from '@/application/ops'
import { describeHomeSaved, getHomeSettingsCommand } from '@/composition/site'

/**
 * 首頁設定的動作（第三波 W3）：存檔、恢復預設、要首頁大圖的上傳憑證。
 * 圖片位元組不走 Server Action，由瀏覽器直接 POST 到 `/api/files/upload`（契約 02 §6）。
 * 規則全在用例裡判；這裡只把表單收斂成用例要的形狀、把結果翻成一句話。
 * 首頁本來就是每次請求重算（`app/layout.tsx` 的 `force-dynamic`），存完不用 revalidate；`refresh()` 只是讓這一頁拿到新版本。
 */

const text = (formData: FormData, name: string, max = 200) => String(formData.get(name) ?? '').slice(0, max)

export async function saveHomeSettingsAction(_state: HomeSettingsActionState, formData: FormData): Promise<HomeSettingsActionState> {
  const hero = text(formData, 'heroFileId', 100)
  const result = await getHomeSettingsCommand().save(
    await currentActor(),
    {
      revision: Number(text(formData, 'revision', 20)),
      heroFileId: hero === '' ? null : hero,
      // 字數上限由用例判（說得出是多少）；這裡只擋掉離譜的大小。
      heroAlt: text(formData, 'heroAlt', 2_000),
      line1: text(formData, 'line1', 2_000),
      line2: text(formData, 'line2', 2_000),
    },
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: describeHomeSaved(false) }
}

export async function resetHomeSettingsAction(_state: HomeSettingsActionState, formData: FormData): Promise<HomeSettingsActionState> {
  const result = await getHomeSettingsCommand().reset(
    await currentActor(),
    { revision: Number(text(formData, 'revision', 20)) },
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: describeHomeSaved(true), reset: true }
}

export async function requestHeroUploadAction(input: {
  fileName: string
  declaredMime: string
  declaredSize: number
}): Promise<{ ok: true; ticket: UploadTicket } | { ok: false; message: string }> {
  const result = await getHomeSettingsCommand().requestHeroUpload(await currentActor(), {
    fileName: String(input?.fileName ?? '').slice(0, 500),
    declaredMime: String(input?.declaredMime ?? '').slice(0, 200),
    declaredSize: typeof input?.declaredSize === 'number' ? input.declaredSize : Number.NaN,
  })
  if (!result.ok) return { ok: false, message: result.message }
  const { ticket, fileId, maxBytes, expiresAt } = result.receipt
  return { ok: true, ticket: { ticket, fileId, maxBytes, expiresAt } }
}
