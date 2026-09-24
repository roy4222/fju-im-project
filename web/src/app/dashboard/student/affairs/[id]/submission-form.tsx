'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import { requestUploadAction, saveDraftAction, submitAction } from '@/app/dashboard/student/affairs/actions'
import type { FileMeta, ReceiptView } from '@/app/dashboard/student/affairs/types'
import type { FormField } from '@/application/items'
import { cn } from '@/shared/cn'

/**
 * 收件的填寫、上傳與送出（票 17 個人版；票 21 組別版：原型 `group-form.tsx` 的共用表單、上傳進度、收件章回執）。
 *
 * - 「儲存草稿」：伺服器存好才顯示「已儲存 時間」；草稿帶版本號，別的分頁、裝置或**別的組員**先存過就被要求重新載入（不無聲覆蓋）。
 * - 檔案欄位：選檔 → 向伺服器要上傳憑證（欄位的類型與大小規則）→ 串流上傳、顯示進度 → 上傳完成自動存一次草稿才算附上。
 *   類型不符（含改副檔名的偽裝檔）、超過上限、傳到一半斷掉都說清楚，不會顯示成已附上。
 * - 「正式送出」：有沒存的修改先存草稿，再把**已存的**那一份送出。必填、格式由伺服器驗，缺的欄位標紅並列出來。
 *   整組一份時任一位組員送出就代表全組。
 * - 成功拿到收件章回執（對話框），不是只有按鈕變色。
 * - 同一次送出用同一個請求編號：連點、斷線後按「再送一次」都只算一次；斷線時顯示「結果尚未確認」，可以去繳交歷史查回執。
 *
 * 規則不在這裡判：錯誤訊息、缺哪幾欄、回執的字都是伺服器回來的。
 */

type Value = string | string[]

type UploadState = { status: 'uploading'; percent: number; name: string } | { status: 'error'; message: string }

const PRIMARY =
  'inline-flex h-11 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground ' +
  'hover:bg-primary/90 disabled:opacity-50'
const SECONDARY =
  'inline-flex h-11 items-center justify-center gap-2 rounded-md border border-border bg-background px-4 text-sm font-medium ' +
  'text-ink hover:bg-muted disabled:opacity-50'
const CONTROL = 'mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm disabled:bg-muted disabled:text-muted-foreground'

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

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  return `${Math.max(1, Math.round(bytes / 1024))} KiB`
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
  initialSavedText,
  editable,
  lockedText,
  submittedVersion: initialSubmittedVersion,
  groupCode,
}: {
  itemId: string
  fields: readonly FormField[]
  initialAnswers: Record<string, Value>
  /** 已附上的檔（檔案 ID → 檔名與大小）。 */
  initialFiles: Record<string, FileMeta>
  initialRevision: number
  initialSavedText: string | null
  editable: boolean
  /** 不能填的原因（尚未開放、已截止、免填）；可以填時是 null。 */
  lockedText: string | null
  submittedVersion: number | null
  /** 整組一份時的組別代號；個人收件是 null。 */
  groupCode: string | null
}) {
  const router = useRouter()
  const [values, setValues] = useState<Record<string, Value>>(initialAnswers)
  const [fileMeta, setFileMeta] = useState<Record<string, FileMeta>>(initialFiles)
  const [uploads, setUploads] = useState<Record<string, UploadState>>({})
  const [revision, setRevision] = useState(initialRevision)
  const [savedText, setSavedText] = useState<string | null>(initialSavedText)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<'save' | 'submit' | 'upload' | null>(null)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)
  const [unknown, setUnknown] = useState(false)
  const [badFields, setBadFields] = useState<readonly string[]>([])
  const [receipt, setReceipt] = useState<ReceiptView | null>(null)
  const [submittedVersion, setSubmittedVersion] = useState(initialSubmittedVersion)
  const dialog = useRef<HTMLDialogElement>(null)
  const requestIds = useRef({ save: newRequestId(), submit: newRequestId() })
  // 存草稿讀的是「最新的」答案：上傳完成後在同一個事件裡自動存，state 還沒重新渲染。所有修改都經 `set`，兩邊一起更新。
  const latest = useRef(initialAnswers)

  const readOnly = !editable || conflict !== null

  function set(key: string, value: Value) {
    const next = { ...latest.current, [key]: value }
    latest.current = next
    setValues(next)
    setDirty(true)
    setBadFields((f) => f.filter((k) => k !== key))
    // 內容變了就是新的一次儲存／送出，換新的請求編號（舊編號配新內容會被當成 REQUEST_MISMATCH）。
    requestIds.current = { save: newRequestId(), submit: newRequestId() }
    setUnknown(false)
  }

  /** 存草稿；回傳存好之後的版本號（失敗回 null，訊息已經顯示）。 */
  async function save(): Promise<number | null> {
    const result = await saveDraftAction(itemId, revision, latest.current, requestIds.current.save)
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
    setRevision(result.data.revision)
    setSavedText(result.data.savedAtText)
    setDirty(false)
    return result.data.revision
  }

  async function onSave() {
    setBusy('save')
    setMessage(null)
    try {
      if ((await save()) !== null) {
        setMessage({
          tone: 'ok',
          text: groupCode
            ? '共用草稿已存到伺服器；同組的人打開會看到同一份。'
            : '草稿已存到伺服器；重新登入或換一台裝置打開都還在。',
        })
      }
    } catch {
      setMessage({ tone: 'error', text: '連線中斷，草稿可能沒有存到；請再按一次「儲存草稿」。' })
    } finally {
      setBusy(null)
    }
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
      // 上傳完成就存一次草稿：檔案在這一步才真正附到（共用）草稿上，其他組員打開才看得到。
      const saved = await save()
      setUploads((u) => {
        const next = { ...u }
        delete next[field.key]
        return next
      })
      if (saved !== null) setMessage({ tone: 'ok', text: `「${file.name}」已上傳並附到草稿。` })
    } catch {
      fail('上傳中斷（連線斷了），檔案沒有附上；請重新上傳。')
    } finally {
      setBusy(null)
    }
  }

  async function sendSubmit(draftRevision: number) {
    const result = await submitAction(itemId, draftRevision, requestIds.current.submit)
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
    setSubmittedVersion(result.data.versionNo)
    dialog.current?.showModal()
  }

  async function onSubmit() {
    setBusy('submit')
    setMessage(null)
    setBadFields([])
    try {
      let draftRevision: number | null = revision
      if (dirty || revision === 0) draftRevision = await save()
      if (draftRevision === null) return
      await sendSubmit(draftRevision)
    } catch {
      setUnknown(true)
    } finally {
      setBusy(null)
    }
  }

  /** 關掉回執（`onClose` 會重新整理伺服器端的狀態：橫幅、繳交歷史的筆數）。 */
  function closeReceipt() {
    dialog.current?.close()
  }

  const status =
    busy === 'save'
      ? '儲存中…'
      : busy === 'submit'
        ? '送出中…'
        : busy === 'upload'
          ? '上傳中…'
          : dirty
            ? '有未儲存的修改'
            : savedText
              ? `已儲存 ${savedText}`
              : '尚未儲存'

  return (
    <form
      noValidate
      className="space-y-5"
      aria-label="填寫與繳交"
      onSubmit={(e) => {
        e.preventDefault()
        if (!busy && !readOnly) void onSubmit()
      }}
    >
      {lockedText ? (
        <p className="rounded-md bg-muted px-3 py-2 text-sm text-ink" role="status">
          {lockedText}
        </p>
      ) : null}

      {conflict ? (
        <div role="alert" className="rounded-md border border-danger/40 bg-danger-subtle px-4 py-3 text-sm text-danger-on-subtle">
          <p className="font-semibold">{conflict}</p>
          <button type="button" className={cn(SECONDARY, 'mt-3 h-10')} onClick={() => window.location.reload()}>
            重新載入
          </button>
        </div>
      ) : null}

      {unknown ? (
        <div role="alert" className="rounded-md border border-border bg-muted px-4 py-3 text-sm text-ink">
          <p className="font-semibold">連線中斷；結果尚未確認。</p>
          <p className="mt-1 text-muted-foreground">
            可能已經收到了。先到「繳交歷史」查回執；沒有看到這一次，再按「再送一次」——同一次送出重送也只算一次。
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href={`/dashboard/student/affairs/${itemId}?tab=history`} className={cn(SECONDARY, 'h-10')}>
              查回執（繳交歷史）
            </Link>
            {/* 走跟「正式送出」同一條路：斷在存草稿那一步時先補存，再送；兩個請求編號都沒換，已送到的只會拿回原回執。 */}
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
            'rounded-md px-3 py-2 text-sm',
            message.tone === 'ok' ? 'bg-primary-subtle text-primary-on-subtle' : 'bg-danger-subtle text-danger-on-subtle',
          )}
        >
          {message.text}
        </p>
      ) : null}

      {fields.map((field) =>
        field.type === 'file' ? (
          <FileInput
            key={field.key}
            field={field}
            fileId={typeof values[field.key] === 'string' ? (values[field.key] as string) : ''}
            meta={fileMeta}
            upload={uploads[field.key]}
            readOnly={readOnly || busy !== null}
            bad={badFields.includes(field.key)}
            onPick={(file) => void onPickFile(field, file)}
            onRemove={() => set(field.key, '')}
          />
        ) : (
          <FieldInput
            key={field.key}
            field={field}
            value={values[field.key]}
            readOnly={readOnly}
            bad={badFields.includes(field.key)}
            onChange={(v) => set(field.key, v)}
          />
        ),
      )}

      <div className="sticky bottom-4 z-10 flex flex-wrap items-center gap-3 rounded-card border border-border bg-background/95 p-3">
        <span className="inline-flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite" data-testid="save-status">
          <span
            aria-hidden
            className={cn('inline-block size-2 rounded-full', !dirty && savedText ? 'bg-primary' : 'border border-muted-foreground')}
          />
          {status}
        </span>
        {editable ? (
          <div className="ml-auto flex flex-wrap gap-2">
            <button type="button" className={SECONDARY} onClick={onSave} disabled={busy !== null || readOnly}>
              儲存草稿
            </button>
            <button type="submit" className={PRIMARY} disabled={busy !== null || readOnly}>
              {submittedVersion ? '重新送出' : groupCode ? '代表全組正式送出' : '正式送出'}
            </button>
          </div>
        ) : null}
      </div>

      <dialog
        ref={dialog}
        aria-labelledby="receipt-title"
        className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-card border border-border bg-background p-6 backdrop:bg-ink/40"
        onClose={() => router.refresh()}
      >
        {receipt ? <ReceiptStamp receipt={receipt} onClose={closeReceipt} /> : null}
      </dialog>
    </form>
  )
}

/** 收件章回執（原型 `ReceiptStamp`）：印章感的「已收件」＋版本、送出者（代表全組）、收件時間、附件、回執編號。 */
function ReceiptStamp({ receipt, onClose }: { receipt: ReceiptView; onClose: () => void }) {
  return (
    <div className="flex flex-col items-center gap-4 text-center" data-testid="receipt">
      <span
        aria-hidden
        className="inline-flex -rotate-2 items-center rounded-lg border-[3px] border-primary px-4 py-1.5 text-base font-extrabold tracking-[0.2em] text-primary"
      >
        已收件
      </span>
      <div>
        <h2 id="receipt-title" className="text-xl font-bold text-ink">
          已正式送出
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{receipt.title}</p>
      </div>
      <dl className="grid w-full grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 border-y border-border py-3 text-left text-sm">
        <dt className="text-muted-foreground">版本</dt>
        <dd className="font-semibold tabular-nums">v{receipt.versionNo}</dd>
        <dt className="text-muted-foreground">送出者</dt>
        <dd className="font-semibold">
          {receipt.submittedByName}
          {receipt.groupCode ? <span className="ml-1 font-normal text-muted-foreground">（代表 {receipt.groupCode} 全組）</span> : null}
        </dd>
        <dt className="text-muted-foreground">收件時間</dt>
        <dd className="font-semibold tabular-nums">{receipt.receivedText}（臺灣時間）</dd>
        <dt className="text-muted-foreground">欄位版本</dt>
        <dd className="tabular-nums">v{receipt.schemaVersionNo}</dd>
        {receipt.files.length > 0 ? (
          <>
            <dt className="text-muted-foreground">附件</dt>
            <dd>
              <ul className="space-y-0.5">
                {receipt.files.map((f) => (
                  <li key={f.fieldKey} className="break-all">
                    {f.name}
                    <span className="ml-1 font-mono text-[11px] text-muted-foreground">sha256 {f.checksumShort}…</span>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">回執編號</dt>
        <dd className="break-all font-mono text-xs">{receipt.receiptNo}</dd>
      </dl>
      <p className="text-xs text-muted-foreground">
        {receipt.groupCode ? '全組已繳；其他組員會收到一則通知。' : ''}截止前可重送，以最後一次為準。每一次的回執都記在「繳交歷史」。
      </p>
      <div className="flex w-full gap-2">
        <Link href="/dashboard/student/affairs" className={cn(SECONDARY, 'flex-1')}>
          回作業區
        </Link>
        <button type="button" className={cn(PRIMARY, 'flex-1')} onClick={onClose}>
          關閉
        </button>
      </div>
    </div>
  )
}

function FieldLabel({ field, htmlFor }: { field: FormField; htmlFor: string }) {
  return (
    <label htmlFor={htmlFor} className="block text-sm font-medium text-ink">
      {field.label}
      {field.required ? (
        <span className="ml-1 text-danger" aria-hidden>
          *
        </span>
      ) : null}
      {field.help ? <span className="ml-2 text-xs font-normal text-muted-foreground">{field.help}</span> : null}
    </label>
  )
}

/** 檔案欄位：上傳區、進度、已附上的檔（可下載、可移除）、錯誤說明。 */
function FileInput({
  field,
  fileId,
  meta,
  upload,
  readOnly,
  bad,
  onPick,
  onRemove,
}: {
  field: FormField
  fileId: string
  meta: Record<string, FileMeta>
  upload: UploadState | undefined
  readOnly: boolean
  bad: boolean
  onPick: (file: File) => void
  onRemove: () => void
}) {
  const id = `field-${field.key}`
  const rules = field.fileRules ?? { allowedTypes: ['pdf'], maxMiB: 20 }
  const accept = rules.allowedTypes.map((t) => (t === 'jpg' ? '.jpg,.jpeg' : `.${t}`)).join(',')
  const hint = `${rules.allowedTypes.map((t) => t.toUpperCase()).join('、')}・單檔 ${rules.maxMiB} MiB 以內`
  const attached = fileId ? meta[fileId] : undefined
  return (
    <div data-testid={`file-field-${field.key}`}>
      <FieldLabel field={field} htmlFor={id} />
      {attached ? (
        <div className={cn('mt-1 flex flex-wrap items-center gap-3 rounded-md border px-3 py-2.5 text-sm', bad ? 'border-danger' : 'border-border')}>
          <a href={`/api/files/${fileId}`} className="min-w-0 break-all font-semibold text-primary-on-subtle underline-offset-2 hover:underline">
            {attached.name}
          </a>
          <span className="text-xs text-muted-foreground tabular-nums">{formatSize(attached.sizeBytes)}</span>
          {!readOnly ? (
            <span className="ml-auto flex gap-2">
              <label className={cn(SECONDARY, 'h-9 cursor-pointer px-3 text-xs')}>
                換檔案
                <input type="file" className="sr-only" accept={accept} onChange={(e) => e.target.files?.[0] && onPick(e.target.files[0])} />
              </label>
              <button type="button" className={cn(SECONDARY, 'h-9 px-3 text-xs')} onClick={onRemove}>
                移除
              </button>
            </span>
          ) : null}
        </div>
      ) : (
        <label
          className={cn(
            'mt-1 flex min-h-11 items-center gap-3 rounded-md border border-dashed px-4 py-3 text-sm',
            bad ? 'border-danger' : 'border-border',
            readOnly ? 'cursor-not-allowed bg-muted text-muted-foreground' : 'cursor-pointer hover:border-primary hover:bg-primary-subtle/40',
          )}
        >
          <span className="font-semibold">{readOnly ? '沒有附檔' : '點擊選擇檔案上傳'}</span>
          <span className="text-xs text-muted-foreground">{hint}</span>
          <input
            id={id}
            type="file"
            className="sr-only"
            accept={accept}
            disabled={readOnly}
            aria-invalid={bad || undefined}
            aria-required={field.required || undefined}
            onChange={(e) => e.target.files?.[0] && onPick(e.target.files[0])}
          />
        </label>
      )}
      {upload?.status === 'uploading' ? (
        <div className="mt-2" role="status" aria-live="polite" data-testid={`upload-progress-${field.key}`}>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span className="truncate">正在上傳 {upload.name}</span>
            <span className="tabular-nums">{upload.percent}%</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
            <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${upload.percent}%` }} />
          </div>
        </div>
      ) : null}
      {upload?.status === 'error' ? (
        <p role="alert" className="mt-2 rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle" data-testid={`upload-error-${field.key}`}>
          {upload.message}
        </p>
      ) : null}
    </div>
  )
}

function FieldInput({
  field,
  value,
  readOnly,
  bad,
  onChange,
}: {
  field: FormField
  value: Value | undefined
  readOnly: boolean
  bad: boolean
  onChange: (value: Value) => void
}) {
  const id = `field-${field.key}`
  const text = typeof value === 'string' ? value : ''
  const picked = Array.isArray(value) ? value : []
  const border = bad ? 'border-danger' : 'border-border'
  const aria = { 'aria-invalid': bad || undefined, 'aria-required': field.required || undefined }
  const label = <FieldLabel field={field} htmlFor={id} />

  switch (field.type) {
    case 'heading':
      return <h3 className="border-b border-border pb-2 pt-2 text-base font-semibold text-ink">{field.label}</h3>
    case 'paragraph':
      return <p className="border-l-[3px] border-border pl-3 text-sm leading-relaxed text-muted-foreground">{field.label}</p>
    case 'textarea':
      return (
        <div>
          {label}
          <textarea
            id={id}
            rows={5}
            className={cn(CONTROL, border)}
            value={text}
            disabled={readOnly}
            onChange={(e) => onChange(e.target.value)}
            {...aria}
          />
        </div>
      )
    case 'radio':
    case 'checkbox':
      return (
        <fieldset aria-invalid={bad || undefined}>
          <legend className="text-sm font-medium text-ink">
            {field.label}
            {field.required ? (
              <span className="ml-1 text-danger" aria-hidden>
                *
              </span>
            ) : null}
          </legend>
          <div className={cn('mt-1 flex flex-wrap gap-2 rounded-md', bad ? 'ring-1 ring-danger' : '')}>
            {(field.options ?? []).map((option, index) => {
              const checked = field.type === 'radio' ? text === option : picked.includes(option)
              return (
                <label
                  key={option}
                  className={cn(
                    'inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm',
                    checked ? 'border-primary bg-primary-subtle' : 'border-border',
                  )}
                >
                  <input
                    type={field.type}
                    id={index === 0 ? id : undefined}
                    name={field.key}
                    checked={checked}
                    disabled={readOnly}
                    className="accent-[var(--color-primary)]"
                    onChange={() =>
                      onChange(
                        field.type === 'radio'
                          ? option
                          : checked
                            ? picked.filter((p) => p !== option)
                            : [...picked, option],
                      )
                    }
                  />
                  {option}
                </label>
              )
            })}
          </div>
        </fieldset>
      )
    case 'select':
      return (
        <div>
          {label}
          <select id={id} className={cn(CONTROL, border)} value={text} disabled={readOnly} onChange={(e) => onChange(e.target.value)} {...aria}>
            <option value="">請選擇</option>
            {(field.options ?? []).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
      )
    default: {
      const type = { number: 'text', email: 'email', url: 'url', date: 'date', time: 'time' }[field.type as string] ?? 'text'
      return (
        <div>
          {label}
          <input
            id={id}
            type={type}
            inputMode={field.type === 'number' ? 'decimal' : undefined}
            className={cn(CONTROL, border)}
            value={text}
            disabled={readOnly}
            onChange={(e) => onChange(e.target.value)}
            {...aria}
          />
        </div>
      )
    }
  }
}
