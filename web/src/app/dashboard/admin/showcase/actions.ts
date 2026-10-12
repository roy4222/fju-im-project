'use server'
import { refresh } from 'next/cache'
import { currentActor } from '@/app/_ui/guard'
import type { ShowcaseActionState } from '@/app/dashboard/admin/showcase/showcase-forms'
import type { UploadTicket } from '@/application/ops'
import type { PublishReceipt, SetHomePositionReceipt } from '@/application/showcase'
import {
  describeCreateDraftReceipt,
  describeDeleteReceipt,
  describePublishReceipt,
  describeRepublishReceipt,
  describeSetAwardReceipt,
  describeUpdateDraftReceipt,
  describeWithdrawReceipt,
  getShowcaseCommand,
} from '@/composition/showcase'

/**
 * 管理員「精選」頁的動作（票 25／S11-03）：替一組建立精選草稿、存草稿、要海報上傳憑證；
 * 第三波 W2：發布（勾同意）、下架、重新發布、設獎項、刪除；W15：補登歷屆作品、首頁順序、發布更新。
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

/** 歷屆補登：選屆別（可以是已封存的）、填題目；沒有組別。 */
export async function createBackfillAction(_state: ShowcaseActionState, formData: FormData): Promise<ShowcaseActionState> {
  const result = await getShowcaseCommand().createBackfill(
    await currentActor(),
    { cohortId: text(formData, 'cohortId', 100), title: text(formData, 'title', 2_000) },
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  const r = result.receipt
  return { ok: true, message: `已補登 ${r.cohortCode} 屆「${r.title}」（歷屆補登，沒有組別）；在下面補摘要、海報與影片連結後儲存，再勾同意發布。` }
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

/** 發布、下架、重新發布、獎項、刪除：表單都帶條目編號、畫面看到的條目版本與請求編號。 */
function entryRef(formData: FormData) {
  return { entryId: text(formData, 'entryId', 100), revision: Number(text(formData, 'revision', 20)) }
}

export async function publishAction(_state: ShowcaseActionState, formData: FormData): Promise<ShowcaseActionState> {
  // 勾的人由用例從登入者取（Q31）；表單只帶有沒有勾。
  const result = await getShowcaseCommand().publish(
    await currentActor(),
    { ...entryRef(formData), consent: formData.get('consent') === 'yes' },
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: describePublishReceipt(result.receipt) }
}

// W15 的兩句回饋：回執句子的函式在 application，但 app 只能經 composition 拿執行期的值（本票不動 composition），
// 所以這兩句寫在這裡，跟 `receipts.ts` 同一個說法。
const who = (r: { groupCode: string | null; title: string }) => `${r.groupCode ?? '歷屆補登'}「${r.title || '（未填題目）'}」`

function describePublishUpdate(r: PublishReceipt): string {
  return `${who(r)} 已發布更新（第 ${r.versionNo} 版），前台換成目前草稿的內容；之前的版本保留在紀錄裡。`
}

function describeHomePosition(r: SetHomePositionReceipt): string {
  if (r.homePosition === null) return `${who(r)} 已取消首頁順序，輪播時排在有填順序的作品後面。`
  return `${who(r)} 的首頁順序已設為 ${r.homePosition}；有獎項且公開中時，首頁輪播依順序由小到大排。`
}

export async function publishUpdateAction(_state: ShowcaseActionState, formData: FormData): Promise<ShowcaseActionState> {
  // 跟發布一樣只帶有沒有勾；勾的人由用例從登入者取（Q31）。
  const result = await getShowcaseCommand().publishUpdate(
    await currentActor(),
    { ...entryRef(formData), consent: formData.get('consent') === 'yes' },
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: describePublishUpdate(result.receipt) }
}

export async function setHomePositionAction(_state: ShowcaseActionState, formData: FormData): Promise<ShowcaseActionState> {
  const result = await getShowcaseCommand().setHomePosition(
    await currentActor(),
    { ...entryRef(formData), position: text(formData, 'homePosition', 20) },
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: describeHomePosition(result.receipt) }
}

export async function withdrawAction(_state: ShowcaseActionState, formData: FormData): Promise<ShowcaseActionState> {
  const result = await getShowcaseCommand().withdraw(await currentActor(), entryRef(formData), text(formData, 'requestId'))
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: describeWithdrawReceipt(result.receipt) }
}

export async function republishAction(_state: ShowcaseActionState, formData: FormData): Promise<ShowcaseActionState> {
  const result = await getShowcaseCommand().republish(await currentActor(), entryRef(formData), text(formData, 'requestId'))
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: describeRepublishReceipt(result.receipt) }
}

export async function setAwardAction(_state: ShowcaseActionState, formData: FormData): Promise<ShowcaseActionState> {
  const result = await getShowcaseCommand().setAward(
    await currentActor(),
    { ...entryRef(formData), level: text(formData, 'awardLevel', 20), label: text(formData, 'awardLabel', 1_000) },
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: describeSetAwardReceipt(result.receipt) }
}

export async function deleteEntryAction(_state: ShowcaseActionState, formData: FormData): Promise<ShowcaseActionState> {
  const result = await getShowcaseCommand().delete(await currentActor(), entryRef(formData), text(formData, 'requestId'))
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: describeDeleteReceipt(result.receipt) }
}

/** 公開區的三個按鈕共用一個狀態（發布後畫面換成「下架」，回饋句子要留著）：依 `intent` 分派。 */
export async function lifecycleAction(state: ShowcaseActionState, formData: FormData): Promise<ShowcaseActionState> {
  switch (formData.get('intent')) {
    case 'publish':
      return publishAction(state, formData)
    case 'withdraw':
      return withdrawAction(state, formData)
    case 'republish':
      return republishAction(state, formData)
    case 'publish_update':
      return publishUpdateAction(state, formData)
    default:
      return { ok: false, message: '看不懂這個動作，請重新整理頁面再試。' }
  }
}
