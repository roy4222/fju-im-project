'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import { IconSend } from '@tabler/icons-react'
import { requestUploadAction, saveDraftAction, submitAction } from '@/app/dashboard/student/affairs/actions'
import type { FileMeta, ReceiptView } from '@/app/dashboard/student/affairs/types'
import type { FormField } from '@/application/items'
import { ChecksumDisclosure, ReceiptNoDisclosure } from '@/app/dashboard/_submissions/proof-disclosure'
import { SECONDARY_BUTTON, SubmissionFields, type FieldUpload, type FieldValue } from '@/app/dashboard/_submissions/submission-fields'
import { cn } from '@/shared/cn'

/**
 * 「寫作業」表單（C 階段規格① §5.2，S6；學生與名單上的老師共用）：欄位照作業的欄位結構畫（`SubmissionFields`），
 * 底部只有一顆「繳交作業」。
 *
 * - **沒有「儲存草稿」鈕**：`submission_drafts` 留作隱形機制。檔案上傳完成就自動存一次草稿（檔案在這一步才附上，
 *   整組一份時其他組員再開「寫作業」也帶得到）；離開頁面不提示。再開「寫作業」時，伺服器只帶草稿裡的檔案（標「上次選的檔案」），
 *   文字欄是空的。
 * - 「繳交作業」：一律先把**畫面上現在的內容**存進草稿、再把那一份送出（草稿裡可能有畫面沒帶出來的舊文字，不能直接送舊草稿）。
 *   兩個分頁同時改用草稿的 `revision` 擋（被要求重新載入，不無聲覆蓋）。必填、格式由伺服器驗，缺的欄位標紅並列出來。
 * - 選檔當下先在瀏覽器檢查大小與類型（`SubmissionFields` → `checkPickedFile`），不合不上傳。
 * - 成功拿到回執（對話框）：整組一份寫「已代表 {組別} 送出第 N 次」。
 * - 同一次送出用同一個請求編號：連點、斷線後按「再送一次」都只算一次；斷線時顯示「結果尚未確認」，可以去繳交歷史查。
 */

type UploadState = FieldUpload

// 主要動作是系網橘實心（btn-fju）。
const PRIMARY = 'btn-fju h-11 rounded-lg px-5 text-sm disabled:opacity-50'

const UPLOAD_ERRORS: Record<number, string> = {
  401: '登入已過期，請重新登入後再上傳。',
  403: '上傳憑證無效或已過期，請重新選擇檔案。',
  413: '檔案超過上限。',
  415: '檔案類型不符（副檔名與內容對不上），已拒絕。',
  429: '上傳太頻繁，請稍後再試。',
}

function newRequestId(): string {
  return crypto.randomUUID()
}

/** 串流上傳（XHR 才有上傳進度）。body 是檔案本身的位元組，不是 multipart（`/api/files/upload` 的約定）。 */
function uploadBytes(
  ticket: string,
  file: File,
  onProgress: (percent: number) => void,
): Promise<{ ok: true } | { ok: false; message: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/files/upload?ticket=${encodeURIComponent(ticket)}`)
    xhr.setRequestHeader('content-type', 'application/octet-stream')
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)))
    }
    xhr.onload = () => {
      if (xhr.status === 201) return resolve({ ok: true })
      let message = UPLOAD_ERRORS[xhr.status] ?? '上傳失敗，請重新上傳。'
      try {
        const body = JSON.parse(xhr.responseText) as { message?: string }
        if (typeof body.message === 'string' && body.message) message = body.message
      } catch {
        // 不是 JSON（反向代理擋下之類）：用狀態碼對應的說明。
      }
      resolve({ ok: false, message })
    }
    xhr.onerror = () => resolve({ ok: false, message: '上傳中斷（連線斷了），檔案沒有附上；請重新上傳。' })
    xhr.onabort = () => resolve({ ok: false, message: '上傳已取消，檔案沒有附上。' })
    xhr.send(file)
  })
}

export function SubmissionForm({
  itemId,
  fields,
  initialAnswers,
  initialFiles,
  initialRevision,
  carriedOver,
  listHref,
  historyHref,
}: {
  itemId: string
  fields: readonly FormField[]
  /** 草稿帶過來的值（只有檔案欄；文字欄不帶）。 */
  initialAnswers: Record<string, FieldValue>
  /** 已附上的檔（檔案 ID → 檔名與大小）。 */
  initialFiles: Record<string, FileMeta>
  /** 草稿目前的版本號（沒有草稿是 0）。 */
  initialRevision: number
  /** 從草稿帶過來的檔案欄（標「上次選的檔案」）。 */
  carriedOver: readonly string[]
  /** 回清單（學生「交作業」、老師「作業區」）。 */
  listHref: string
  /** 這一份作業的繳交歷史。 */
  historyHref: string
}) {
  const router = useRouter()
  const [values, setValues] = useState<Record<string, FieldValue>>(initialAnswers)
  const [fileMeta, setFileMeta] = useState<Record<string, FileMeta>>(initialFiles)
  const [uploads, setUploads] = useState<Record<string, UploadState>>({})
  const [kept, setKept] = useState<readonly string[]>(carriedOver)
  const [busy, setBusy] = useState<'submit' | 'upload' | null>(null)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)
  const [unknown, setUnknown] = useState(false)
  const [badFields, setBadFields] = useState<readonly string[]>([])
  const [receipt, setReceipt] = useState<ReceiptView | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const requestIds = useRef({ save: newRequestId(), submit: newRequestId() })
  // 存草稿讀的是「最新的」答案：上傳完成後在同一個事件裡自動存，state 還沒重新渲染。所有修改都經 `set`，兩邊一起更新。
  const latest = useRef(initialAnswers)
  // 草稿版本號同理（上傳自動存完、馬上按繳交）；只拿來送，畫面不顯示。
  const revisionRef = useRef(initialRevision)
  // 已經存好、正在送出的那一版草稿：送出的回應斷在路上時，「再送一次」只重送這一步（同一個請求編號配同一版），不再重存。
  const pending = useRef<number | null>(null)

  const readOnly = conflict !== null

  function set(key: string, value: FieldValue) {
    const next = { ...latest.current, [key]: value }
    latest.current = next
    setValues(next)
    setKept((k) => k.filter((x) => x !== key))
    setBadFields((f) => f.filter((k) => k !== key))
    // 內容變了就是新的一次儲存／送出，換新的請求編號（舊編號配新內容會被當成 REQUEST_MISMATCH）。
    requestIds.current = { save: newRequestId(), submit: newRequestId() }
    pending.current = null
    setUnknown(false)
  }

  /** 把畫面上的內容存進（隱形的）草稿；回傳存好之後的版本號（失敗回 null，訊息已經顯示）。 */
  async function save(): Promise<number | null> {
    const result = await saveDraftAction(itemId, revisionRef.current, latest.current, requestIds.current.save)
    if (!result.ok) {
      if (result.code === 'CONFLICT') setConflict(result.message)
      else {
        setMessage({ tone: 'error', text: result.message })
        if (result.fields) setBadFields(result.fields)
      }
      requestIds.current.save = newRequestId()
      return null
    }
    requestIds.current.save = newRequestId()
    revisionRef.current = result.data.revision
    return result.data.revision
  }

  async function onPickFile(field: FormField, file: File) {
    setBusy('upload')
    setMessage(null)
    setUploads((u) => ({ ...u, [field.key]: { status: 'uploading', percent: 0, name: file.name } }))
    const fail = (text: string) => setUploads((u) => ({ ...u, [field.key]: { status: 'error', message: text } }))
    try {
      const grant = await requestUploadAction(itemId, field.key, file.name, file.type, file.size)
      if (!grant.ok) return fail(grant.message)
      const sent = await uploadBytes(grant.data.ticket, file, (percent) =>
        setUploads((u) => ({ ...u, [field.key]: { status: 'uploading', percent, name: file.name } })),
      )
      if (!sent.ok) return fail(sent.message)
      setFileMeta((m) => ({ ...m, [grant.data.fileId]: { name: file.name, sizeBytes: file.size } }))
      set(field.key, grant.data.fileId)
      // 上傳完成就自動存一次草稿：檔案在這一步才真正附上，離開再回來（或其他組員）按「寫作業」都帶得到。
      const saved = await save()
      setUploads((u) => {
        const next = { ...u }
        delete next[field.key]
        return next
      })
      if (saved !== null) setMessage({ tone: 'ok', text: `「${file.name}」已上傳。按「繳交作業」才算交出。` })
    } catch {
      fail('上傳中斷（連線斷了），檔案沒有附上；請重新上傳。')
    } finally {
      setBusy(null)
    }
  }

  async function sendSubmit(draftRevision: number) {
    const result = await submitAction(itemId, draftRevision, requestIds.current.submit)
    pending.current = null
    if (!result.ok) {
      requestIds.current.submit = newRequestId()
      if (result.code === 'CONFLICT') setConflict(result.message)
      else {
        setMessage({ tone: 'error', text: result.message })
        setBadFields(result.fields ?? [])
        const first = result.fields?.[0]
        if (first) document.getElementById(`field-${first}`)?.focus()
      }
      return
    }
    requestIds.current.submit = newRequestId()
    setUnknown(false)
    setReceipt(result.data)
    dialog.current?.showModal()
  }

  async function onSubmit() {
    setBusy('submit')
    setMessage(null)
    setBadFields([])
    try {
      // 一律先存畫面上的內容：送出的就是學生眼前這一份。存的回應斷掉時重按，同一個請求編號重存只拿回原結果。
      let draftRevision = pending.current
      if (draftRevision === null) {
        draftRevision = await save()
        if (draftRevision === null) return
        pending.current = draftRevision
      }
      await sendSubmit(draftRevision)
    } catch {
      setUnknown(true)
    } finally {
      setBusy(null)
    }
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-5"
      aria-label="寫作業"
      onSubmit={(e) => {
        e.preventDefault()
        if (!busy && !readOnly) void onSubmit()
      }}
    >
      {conflict ? (
        <div role="alert" className="rounded-lg border border-destructive/35 bg-destructive-subtle px-4 py-3 text-sm text-destructive-on-subtle">
          <p className="font-semibold">{conflict}</p>
          <button type="button" className={cn(SECONDARY_BUTTON, 'mt-3 h-10')} onClick={() => window.location.reload()}>
            重新載入
          </button>
        </div>
      ) : null}

      {unknown ? (
        <div role="alert" className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-ink">
          <p className="font-semibold">連線中斷；結果尚未確認。</p>
          <p className="mt-1 text-muted-foreground">
            可能已經收到了。先到「繳交歷史」看有沒有這一次；沒有看到這一次，再按「再送一次」——同一次送出重送也只算一次。
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href={historyHref} className={cn(SECONDARY_BUTTON, 'h-10')}>
              看繳交歷史
            </Link>
            <button type="button" className={cn(PRIMARY, 'h-10')} onClick={onSubmit} disabled={busy !== null}>
              再送一次
            </button>
          </div>
        </div>
      ) : null}

      {message ? (
        <p
          role={message.tone === 'ok' ? 'status' : 'alert'}
          className={cn(
            'rounded-lg px-4 py-2.5 text-sm',
            message.tone === 'ok' ? 'bg-success-subtle text-success-on-subtle' : 'bg-destructive-subtle text-destructive-on-subtle',
          )}
        >
          {message.text}
        </p>
      ) : null}

      <SubmissionFields
        fields={fields}
        values={values}
        files={fileMeta}
        uploads={uploads}
        readOnly={readOnly || busy !== null}
        badFields={badFields}
        carriedOver={kept}
        onChange={set}
        onPickFile={(field, file) => void onPickFile(field, file)}
      />

      <div className="sticky bottom-4 z-10 mt-2 flex flex-wrap items-center justify-end gap-3 rounded-xl border border-border bg-background/95 p-3 backdrop-blur">
        {busy ? (
          <span className="mr-auto text-xs text-muted-foreground" aria-live="polite">
            {busy === 'submit' ? '送出中…' : '上傳中…'}
          </span>
        ) : null}
        <button type="submit" className={PRIMARY} disabled={busy !== null || readOnly}>
          <IconSend className="size-4" aria-hidden /> 繳交作業
        </button>
      </div>

      <dialog
        ref={dialog}
        aria-labelledby="receipt-title"
        className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-border bg-popover p-6 shadow-xl backdrop:bg-ink/40"
        onClose={() => router.push(historyHref)}
      >
        {receipt ? <ReceiptStamp receipt={receipt} listHref={listHref} onClose={() => dialog.current?.close()} /> : null}
      </dialog>
    </form>
  )
}

/** 收件章回執（原型 `ReceiptStamp`）：印章感的「已送出」＋送出者（代表全組）、收件時間、附件、繳交證明編號（收合）。 */
function ReceiptStamp({ receipt, listHref, onClose }: { receipt: ReceiptView; listHref: string; onClose: () => void }) {
  return (
    <div className="flex flex-col items-center gap-4 text-center" data-testid="receipt">
      <span
        aria-hidden
        className="inline-flex rotate-[-2deg] items-center rounded-lg border-[3px] border-brand px-4 py-1.5 text-[15px] font-extrabold tracking-[0.2em] text-brand duration-200 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-110"
      >
        已送出
      </span>
      <div>
        <h2 id="receipt-title" className="text-xl font-extrabold">
          {receipt.groupCode ? `已代表 ${receipt.groupCode} 送出第 ${receipt.versionNo} 次` : `已送出第 ${receipt.versionNo} 次`}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{receipt.title}</p>
      </div>
      <dl className="grid w-full grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 border-y border-border py-3 text-left text-sm">
        <dt className="text-muted-foreground">繳交人</dt>
        <dd className="font-semibold">{receipt.submittedByName}</dd>
        <dt className="text-muted-foreground">送出時間</dt>
        <dd className="font-semibold tabular-nums">{receipt.receivedText}（臺灣時間）</dd>
        {receipt.files.length > 0 ? (
          <>
            <dt className="text-muted-foreground">附件</dt>
            <dd>
              <ul className="space-y-0.5">
                {receipt.files.map((f) => (
                  <li key={f.fieldKey} className="break-all">
                    {f.name}
                    <ChecksumDisclosure checksum={f.checksum} />
                  </li>
                ))}
              </ul>
            </dd>
          </>
        ) : null}
      </dl>
      <ReceiptNoDisclosure requestId={receipt.receiptNo} className="w-full text-left" />
      <p className="text-xs text-muted-foreground">
        {receipt.groupCode ? '全組已繳；其他組員會收到一則通知。' : ''}截止前可重送，以最後一次為準。每一次送出都記在「繳交歷史」。
      </p>
      <div className="flex w-full gap-2">
        <button type="button" className={cn(SECONDARY_BUTTON, 'flex-1')} onClick={onClose}>
          關閉
        </button>
        <Link href={listHref} className={cn(PRIMARY, 'flex-1')}>
          回清單
        </Link>
      </div>
    </div>
  )
}
