'use server'
import { currentActor } from '@/app/_ui/guard'
import type { UploadTicket } from '@/application/ops'
import type { SiteTextKey } from '@/application/site'
import { getHomeSettingsCommand, getSiteTextsCommand } from '@/composition/site'

/**
 * 前台編輯②的 Server Function（C2-17；規格② 設計方案 §6.5）：站內文字存檔、首頁橫幅存檔與上傳憑證。
 * 規則全在用例裡判（必填、字數、版本）；這裡只把表單收斂成用例要的形狀、把結果翻成一句話。
 * 前台頁每次請求重算（`app/layout.tsx` 的 `force-dynamic`），存完不用 revalidate；重整畫面由編輯層的 `router.refresh()` 做。
 */

type FeSaveResult = { ok: true; revision: number } | { ok: false; message: string; field?: string }

const text = (value: unknown, max: number) => String(value ?? '').slice(0, max)

export async function saveSiteTextAction(input: {
  key: string
  revision: number
  requestId: string
  fields: Record<string, string>
}): Promise<FeSaveResult> {
  const fields: Record<string, string> = {}
  // 字數上限由用例判（說得出是多少）；這裡只擋掉離譜的大小。
  for (const [name, value] of Object.entries(input?.fields ?? {})) fields[text(name, 40)] = text(value, 40_000)
  const result = await getSiteTextsCommand().save(
    await currentActor(),
    text(input?.key, 40) as SiteTextKey,
    fields,
    Number(input?.revision),
    text(input?.requestId, 60),
  )
  if (!result.ok) {
    const field = result.details && typeof result.details === 'object' && 'field' in result.details ? String(result.details.field) : undefined
    return { ok: false, message: result.message, field }
  }
  return { ok: true, revision: result.receipt.revision }
}

export async function saveHeroAction(input: {
  revision: number
  requestId: string
  heroFileId: string
  heroAlt: string
  line1: string
  line2: string
}): Promise<FeSaveResult> {
  const hero = text(input?.heroFileId, 100)
  const result = await getHomeSettingsCommand().save(
    await currentActor(),
    {
      revision: Number(input?.revision),
      heroFileId: hero === '' ? null : hero,
      heroAlt: text(input?.heroAlt, 2_000),
      line1: text(input?.line1, 2_000),
      line2: text(input?.line2, 2_000),
    },
    text(input?.requestId, 60),
  )
  if (!result.ok) return { ok: false, message: result.message }
  return { ok: true, revision: result.receipt.revision }
}

export async function requestHeroUploadAction(input: {
  fileName: string
  declaredMime: string
  declaredSize: number
}): Promise<{ ok: true; ticket: UploadTicket } | { ok: false; message: string }> {
  const result = await getHomeSettingsCommand().requestHeroUpload(await currentActor(), {
    fileName: text(input?.fileName, 500),
    declaredMime: text(input?.declaredMime, 200),
    declaredSize: typeof input?.declaredSize === 'number' ? input.declaredSize : Number.NaN,
  })
  if (!result.ok) return { ok: false, message: result.message }
  const { ticket, fileId, maxBytes, expiresAt } = result.receipt
  return { ok: true, ticket: { ticket, fileId, maxBytes, expiresAt } }
}
