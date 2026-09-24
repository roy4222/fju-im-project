'use server'
import { currentActor } from '@/app/_ui/guard'
import type { AffairOutcome, ReceiptView } from '@/app/dashboard/student/affairs/types'
import { describeReceipt, getSubmissionCommand } from '@/composition/submissions'
import type { Result } from '@/shared/result'
import { formatTaipeiMinute, formatTaipeiSecond } from '@/shared/time'

/**
 * 作業區的 Server Action（票 17）：存草稿、正式送出。
 *
 * 規則與授權全在用例裡判（名單、開放、截止、樂觀鎖、帳本冪等）；這裡只把瀏覽器送來的東西收斂成用例要的形狀、
 * 把結果翻成畫面要的回饋。請求編號由畫面產生：同一次送出（連點、斷線重試）帶同一個編號，伺服器只算一次。
 */

function fail<T>(result: Result<T> & { ok: false }): AffairOutcome<never> {
  const details = result.details ?? {}
  const fields = Array.isArray(details.fields)
    ? (details.fields as unknown[]).filter((f): f is string => typeof f === 'string')
    : typeof details.field === 'string'
      ? [details.field]
      : undefined
  return { ok: false, code: result.code, message: result.message, ...(fields ? { fields } : {}) }
}

const str = (value: unknown, max = 100) => (typeof value === 'string' ? value.slice(0, max) : '')

/** 答案只收一層物件、值是字串或字串陣列；型別與選項在用例裡再判。 */
function answersOf(raw: unknown): Record<string, string | string[]> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, 100)) {
    if (typeof value === 'string') out[key.slice(0, 60)] = value.slice(0, 20_000)
    else if (Array.isArray(value)) out[key.slice(0, 60)] = value.filter((v): v is string => typeof v === 'string').slice(0, 50)
  }
  return out
}

export async function saveDraftAction(
  itemId: string,
  revision: number,
  answers: unknown,
  requestId: string,
): Promise<AffairOutcome<{ revision: number; savedAtText: string }>> {
  const result = await getSubmissionCommand().saveDraft(
    await currentActor(),
    str(itemId),
    Number(revision),
    answersOf(answers),
    str(requestId),
  )
  if (!result.ok) return fail(result)
  return { ok: true, data: { revision: result.receipt.revision, savedAtText: formatTaipeiMinute(new Date(result.receipt.savedAt)) } }
}

export async function submitAction(itemId: string, draftRevision: number, requestId: string): Promise<AffairOutcome<ReceiptView>> {
  const result = await getSubmissionCommand().submit(await currentActor(), str(itemId), Number(draftRevision), str(requestId))
  if (!result.ok) return fail(result)
  const r = result.receipt
  return {
    ok: true,
    data: {
      title: r.title,
      versionNo: r.versionNo,
      submittedByName: r.submittedByName,
      receivedText: formatTaipeiSecond(new Date(r.receivedBusinessAt)),
      schemaVersionNo: r.schemaVersionNo,
      receiptNo: r.requestId,
      sentence: describeReceipt(r),
    },
  }
}
