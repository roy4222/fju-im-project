'use server'
import { refresh } from 'next/cache'
import { currentActor } from '@/app/_ui/guard'
import type { ShowcaseActionState } from '@/app/dashboard/admin/showcase/showcase-forms'
import { HOME_POSITION_MAX, type SaveEntryInput, type SaveEntryRequestIds, type SaveEntryResult } from '@/app/dashboard/admin/showcase/showcase-view'
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
  getShowcaseQuery,
} from '@/composition/showcase'

/**
 * 管理員「精選」頁的動作（票 25／S11-03）：替一組建立精選草稿、存草稿、要海報上傳憑證；
 * 第三波 W2：發布（勾同意）、下架、重新發布、設獎項、刪除；W15：補登歷屆作品、首頁順序、發布更新。
 * 海報的位元組不走 Server Action，由瀏覽器直接 POST 到 `/api/files/upload`（契約 02 §6）。
 * 規則全在用例裡判；這裡只把表單收斂成用例要的形狀、把結果翻成一句話。
 *
 * C1-09（C 階段規格① §4.5、§11.3）：清單＋編輯視窗。`saveEntryAction` 把視窗裡改過的部分依序交給上面這些既有用例，
 * 一次存齊；`saveHomeOrderAction` 存拖曳後的首頁順序；`showcaseFeStateAction` 給前台「精選」勾讀目前的版本與順序。
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
  return { ok: true, message: `已補登${r.cohortName}（${r.cohortCode}）「${r.title}」（歷屆補登，沒有組別）；在下面補摘要、海報與影片連結後儲存，再勾同意發布。` }
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
  // 欄位錯（例如影片不是 YouTube）帶回是哪一欄，表單把訊息放在那一欄下面。
  if (!result.ok) return { ok: false, message: result.message, field: typeof result.details?.field === 'string' ? result.details.field : undefined }
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

// ── C1-09：編輯視窗一次存齊 ──────────────────────────────────────────────────

const str = (value: unknown, max: number) => String(value ?? '').slice(0, max)

export async function saveEntryAction(input: SaveEntryInput): Promise<SaveEntryResult> {
  const actor = await currentActor()
  const command = getShowcaseCommand()
  const ids = input?.requestIds ?? ({} as SaveEntryRequestIds)
  const done: string[] = []
  // 前面幾步已經存進去、後面某一步失敗：照實說哪些存好了，請重新開啟視窗再改（版本已經變了）。
  const fail = (message: string, field?: string): SaveEntryResult => {
    if (done.length > 0) refresh()
    return done.length > 0
      ? { ok: false, message: `${done.join(' ')} 但接下來這一步沒存到：${message} 請關掉視窗重新開啟再試。` }
      : { ok: false, message, field }
  }

  let entryId = str(input?.entryId, 100)
  let entryRevision = Number(input?.entryRevision)
  let draftRevision = Number(input?.draftRevision)
  let draft = input?.draft ?? null

  if (input?.mode === 'create') {
    const created = await command.createDraft(actor, { groupId: str(input.groupId, 100) }, str(ids.create, 100))
    if (!created.ok) return fail(created.message)
    entryId = created.receipt.entryId
    entryRevision = 1
    draftRevision = created.receipt.revision
    done.push(`已替 ${created.receipt.groupCode} 建立成果展示草稿。`)
    // 新草稿本來就是空白：都沒填就不必再存一次草稿。
    if (draft && draft.title === '' && draft.summary === '' && draft.videoUrl === '' && draft.posterFileId === null) draft = null
  } else if (input?.mode === 'backfill') {
    const created = await command.createBackfill(
      actor,
      { cohortId: str(input.cohortId, 100), title: str(draft?.title, 2_000) },
      str(ids.create, 100),
    )
    if (!created.ok) return fail(created.message)
    const r = created.receipt
    entryId = r.entryId
    entryRevision = 1
    draftRevision = r.revision
    done.push(`已補登${r.cohortName}（${r.cohortCode}）「${r.title}」（歷屆補登，沒有組別）。`)
    // 題目已經跟著補登存進去；只有摘要或影片也填了才再存一次草稿。
    if (draft && draft.summary === '' && draft.videoUrl === '' && draft.posterFileId === null) draft = null
  }

  if (draft) {
    const result = await command.updateDraft(
      actor,
      {
        entryId,
        revision: draftRevision,
        title: str(draft.title, 2_000),
        summary: str(draft.summary, 20_000),
        videoUrl: str(draft.videoUrl, 2_000),
        posterFileId: draft.posterFileId ? str(draft.posterFileId, 100) : null,
      },
      str(ids.draft, 100),
    )
    if (!result.ok) return fail(result.message, typeof result.details?.field === 'string' ? result.details.field : undefined)
    // 存草稿同時把條目版本加 1（`showcase_entries.revision`）。
    entryRevision += 1
    done.push(describeUpdateDraftReceipt(result.receipt))
  }

  if (input?.award) {
    const result = await command.setAward(
      actor,
      { entryId, revision: entryRevision, level: str(input.award.level, 20), label: str(input.award.label, 1_000) },
      str(ids.award, 100),
    )
    if (!result.ok) return fail(result.message)
    entryRevision = result.receipt.revision
    done.push(describeSetAwardReceipt(result.receipt))
  }

  if (input?.home) {
    const result = await command.setHomePosition(actor, { entryId, revision: entryRevision, position: str(input.home.position, 20) }, str(ids.home, 100))
    if (!result.ok) return fail(result.message)
    entryRevision = result.receipt.revision
    done.push(describeHomePosition(result.receipt))
  }

  const ref = { entryId, revision: entryRevision }
  const consent = input?.consent === true
  if (input?.lifecycle === 'publish') {
    const result = await command.publish(actor, { ...ref, consent }, str(ids.lifecycle, 100))
    if (!result.ok) return fail(result.message)
    done.push(describePublishReceipt(result.receipt))
  } else if (input?.lifecycle === 'publish_update') {
    const result = await command.publishUpdate(actor, { ...ref, consent }, str(ids.lifecycle, 100))
    if (!result.ok) return fail(result.message)
    done.push(describePublishUpdate(result.receipt))
  } else if (input?.lifecycle === 'republish') {
    const result = await command.republish(actor, ref, str(ids.lifecycle, 100))
    if (!result.ok) return fail(result.message)
    done.push(describeRepublishReceipt(result.receipt))
  }

  if (done.length === 0) return { ok: true, message: '沒有改動。', entryId }
  refresh()
  return { ok: true, message: done.join(' '), entryId }
}

/** 拖曳或輸入數字後存首頁順序：每件一個請求編號，依序存；任何一件失敗就停下並說存到哪裡。 */
export async function saveHomeOrderAction(
  items: readonly { entryId: string; revision: number; position: number; requestId: string }[],
): Promise<{ ok: boolean; message: string }> {
  const actor = await currentActor()
  const list = Array.isArray(items) ? items.slice(0, HOME_POSITION_MAX) : []
  let saved = 0
  for (const item of list) {
    const result = await getShowcaseCommand().setHomePosition(
      actor,
      { entryId: str(item?.entryId, 100), revision: Number(item?.revision), position: Number(item?.position) },
      str(item?.requestId, 100),
    )
    if (!result.ok) {
      if (saved > 0) refresh()
      return { ok: false, message: saved > 0 ? `已存好前 ${saved} 件，接下來這件沒存到：${result.message}` : result.message }
    }
    saved += 1
  }
  if (saved > 0) refresh()
  return { ok: true, message: saved > 0 ? `首頁順序已更新（${saved} 件）。` : '首頁順序沒有改動。' }
}

/** 前台「精選」勾（§11.3 `showcase` kind）開窗時讀：這件作品目前的條目版本、首頁順序，以及目前最後一個順序。 */
export async function showcaseFeStateAction(
  entryId: string,
): Promise<{ ok: true; revision: number; homePosition: number | null; lastPosition: number; title: string } | { ok: false; message: string }> {
  const board = await getShowcaseQuery().adminBoard(await currentActor(), { cohortId: null, createCohortId: null })
  if (!board.ok) return { ok: false, message: board.message }
  const id = str(entryId, 100)
  const entry = board.receipt.drafts.find((d) => d.entryId === id)
  if (!entry) return { ok: false, message: '找不到這件作品，請重新整理頁面。' }
  const lastPosition = Math.max(0, ...board.receipt.drafts.map((d) => d.homePosition ?? 0))
  return { ok: true, revision: entry.entryRevision, homePosition: entry.homePosition, lastPosition, title: entry.title }
}
