'use server'
import { currentActor } from '@/app/_ui/guard'
import type { ItemInput, ItemReview, SaveReceipt } from '@/application/items'
import type { UploadTicket } from '@/application/ops'
import { describeLifecycleReceipt, describePublishReceipt, describeUpdateReceipt, getItemCommand } from '@/composition/items'
import type { Result } from '@/shared/result'

/**
 * 專題事務的 Server Action（票 15）：建立、存草稿、發布前檢查、發布、發布更新、附件上傳 ticket；
 * 票 16：撤回、下架、重新發布。
 *
 * 規則與授權全在用例裡判（只有狀態正常的管理員）；這裡只把瀏覽器送來的東西整理成用例要的形狀、
 * 把結果翻成畫面要的回饋。檔案位元組不走 Server Action，由瀏覽器直接 POST 到 `/api/files/upload`。
 *
 * 這裡**不**呼叫 `refresh()`：編輯器第一次存檔會把網址換成 `/editor/<id>`，伺服器端一刷新就會換成另一頁、
 * 把畫面上的回執洗掉。改由畫面在關掉對話框時自己 `router.refresh()`。
 */

type ItemActionOutcome<T> =
  | { ok: true; data: T; message?: string }
  | { ok: false; code: string; message: string; field?: string; checks?: string[] }

function toOutcome<T, R>(result: Result<T>, map: (receipt: Result<T> & { ok: true }) => R, message?: (r: R) => string): ItemActionOutcome<R> {
  if (!result.ok) {
    const field = typeof result.details?.field === 'string' ? result.details.field : undefined
    const checks = Array.isArray(result.details?.checks) ? (result.details.checks as string[]) : undefined
    return { ok: false, code: result.code, message: result.message, ...(field ? { field } : {}), ...(checks ? { checks } : {}) }
  }
  const data = map(result as Result<T> & { ok: true })
  return { ok: true, data, ...(message ? { message: message(data) } : {}) }
}

const str = (value: unknown, max = 200_000) => (typeof value === 'string' ? value.slice(0, max) : '')
const ids = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').slice(0, 500) : [])

/** 瀏覽器送來的編輯器內容 → 用例的輸入（型別與長度先收斂；規則在用例裡判）。 */
function toItemInput(raw: unknown): ItemInput {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    cohortId: str(r.cohortId, 100),
    placement: str(r.placement, 40),
    title: str(r.title, 1000),
    summary: str(r.summary, 2000),
    body: str(r.body),
    category: str(r.category, 200),
    coverFileId: typeof r.coverFileId === 'string' && r.coverFileId !== '' ? r.coverFileId.slice(0, 100) : null,
    attachmentFileIds: ids(r.attachmentFileIds),
    audienceKind: str(r.audienceKind, 40),
    groupIds: ids(r.groupIds),
    receiverUnit: str(r.receiverUnit, 40),
    stageId: typeof r.stageId === 'string' && r.stageId !== '' ? r.stageId.slice(0, 100) : null,
    opensAt: str(r.opensAt, 40),
    dueAt: str(r.dueAt, 40),
    fields: Array.isArray(r.fields) ? r.fields.slice(0, 200) : [],
  }
}

export async function createItemAction(raw: unknown, requestId: string): Promise<ItemActionOutcome<SaveReceipt>> {
  const result = await getItemCommand().create(await currentActor(), toItemInput(raw), str(requestId, 100))
  return toOutcome(result, (r) => ({ itemId: r.receipt.itemId, revision: r.receipt.revision, status: r.receipt.status }))
}

export async function saveDraftAction(
  itemId: string,
  revision: number,
  raw: unknown,
  requestId: string,
): Promise<ItemActionOutcome<SaveReceipt>> {
  const result = await getItemCommand().saveDraft(
    await currentActor(),
    str(itemId, 100),
    Number(revision),
    toItemInput(raw),
    str(requestId, 100),
  )
  return toOutcome(result, (r) => ({ itemId: r.receipt.itemId, revision: r.receipt.revision, status: r.receipt.status }))
}

export async function reviewItemAction(raw: unknown, itemId: string | null): Promise<ItemActionOutcome<ItemReview>> {
  const result = await getItemCommand().review(await currentActor(), toItemInput(raw), itemId ? str(itemId, 100) : null)
  return toOutcome(result, (r) => ({
    checks: r.receipt.checks,
    recipients: r.receipt.recipients,
    bodyHtml: r.receipt.bodyHtml,
    deadlineText: r.receipt.deadlineText,
    openText: r.receipt.openText,
    hasResponses: r.receipt.hasResponses,
  }))
}

export async function publishItemAction(
  itemId: string,
  revision: number,
  notify: boolean,
  requestId: string,
): Promise<ItemActionOutcome<{ itemId: string; revision: number }>> {
  const result = await getItemCommand().publish(
    await currentActor(),
    str(itemId, 100),
    Number(revision),
    { notify: notify === true },
    str(requestId, 100),
  )
  return toOutcome(
    result,
    (r) => ({ itemId: r.receipt.itemId, revision: r.receipt.revision, sentence: describePublishReceipt(r.receipt) }),
    (d) => d.sentence,
  )
}

export async function updatePublishedAction(
  itemId: string,
  revision: number,
  raw: unknown,
  notify: boolean,
  requestId: string,
): Promise<ItemActionOutcome<{ itemId: string; revision: number }>> {
  const result = await getItemCommand().updatePublished(
    await currentActor(),
    str(itemId, 100),
    Number(revision),
    toItemInput(raw),
    { notify: notify === true },
    str(requestId, 100),
  )
  return toOutcome(
    result,
    (r) => ({ itemId: r.receipt.itemId, revision: r.receipt.revision, sentence: describeUpdateReceipt(r.receipt) }),
    (d) => d.sentence,
  )
}

/** 撤回、下架、重新發布（票 16）。規則在用例（撤回只有沒有回答時、重新發布不重設開放時間）。 */
export async function changeItemStatusAction(
  itemId: string,
  revision: number,
  action: string,
  requestId: string,
): Promise<ItemActionOutcome<{ itemId: string; revision: number; status: 'draft' | 'published' | 'archived' }>> {
  const known = action === 'withdraw' || action === 'archive' || action === 'republish' ? action : null
  if (!known) return { ok: false, code: 'VALIDATION_FAILED', message: '不認得這個動作，請重新整理頁面。' }
  const result = await getItemCommand().changeStatus(
    await currentActor(),
    str(itemId, 100),
    Number(revision),
    known,
    str(requestId, 100),
  )
  return toOutcome(
    result,
    (r) => ({
      itemId: r.receipt.itemId,
      revision: r.receipt.revision,
      status: r.receipt.status,
      sentence: describeLifecycleReceipt(r.receipt),
    }),
    (d) => d.sentence,
  )
}

export async function startItemUploadAction(input: {
  cohortId: string
  kind: 'attachment' | 'cover'
  fileName: string
  declaredMime: string
  declaredSize: number
}): Promise<ItemActionOutcome<UploadTicket>> {
  const result = await getItemCommand().startUpload(await currentActor(), {
    cohortId: str(input?.cohortId, 100),
    kind: input?.kind === 'cover' ? 'cover' : 'attachment',
    fileName: str(input?.fileName, 500),
    declaredMime: str(input?.declaredMime, 200),
    declaredSize: typeof input?.declaredSize === 'number' ? input.declaredSize : Number.NaN,
  })
  return toOutcome(result, (r) => ({
    ticket: r.receipt.ticket,
    fileId: r.receipt.fileId,
    maxBytes: r.receipt.maxBytes,
    expiresAt: r.receipt.expiresAt,
  }))
}
