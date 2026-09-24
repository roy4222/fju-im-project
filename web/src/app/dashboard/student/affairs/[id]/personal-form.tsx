'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import { saveDraftAction, submitAction } from '@/app/dashboard/student/affairs/actions'
import type { ReceiptView } from '@/app/dashboard/student/affairs/types'
import type { FormField } from '@/application/items'
import { cn } from '@/shared/cn'

/**
 * 個人收件的填寫與送出（票 17；原型 `group-form.tsx` 的個人版）。
 *
 * - 「儲存草稿」：伺服器存好才顯示「已儲存 時間」；草稿帶版本號，別的分頁或裝置先存過就被要求重新載入（不無聲覆蓋）。
 * - 「正式送出」：有沒存的修改先存草稿，再把**已存的**那一份送出。必填、格式由伺服器驗，缺的欄位標紅並列出來。
 * - 成功拿到收件章回執（對話框），不是只有按鈕變色。
 * - 同一次送出用同一個請求編號：連點、斷線後按「再送一次」都只算一次；斷線時顯示「結果尚未確認」，可以去繳交歷史查回執。
 *
 * 規則不在這裡判：錯誤訊息、缺哪幾欄、回執的字都是伺服器回來的。
 */

type Value = string | string[]

const PRIMARY =
  'inline-flex h-11 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground ' +
  'hover:bg-primary/90 disabled:opacity-50'
const SECONDARY =
  'inline-flex h-11 items-center justify-center gap-2 rounded-md border border-border bg-background px-4 text-sm font-medium ' +
  'text-ink hover:bg-muted disabled:opacity-50'
const CONTROL = 'mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm disabled:bg-muted disabled:text-muted-foreground'

function newRequestId(): string {
  return crypto.randomUUID()
}

export function PersonalForm({
  itemId,
  fields,
  initialAnswers,
  initialRevision,
  initialSavedText,
  editable,
  lockedText,
  submittedVersion: initialSubmittedVersion,
  filePendingMessage,
}: {
  itemId: string
  fields: readonly FormField[]
  initialAnswers: Record<string, Value>
  initialRevision: number
  initialSavedText: string | null
  editable: boolean
  /** 不能填的原因（尚未開放、已截止、免填）；可以填時是 null。 */
  lockedText: string | null
  submittedVersion: number | null
  filePendingMessage: string
}) {
  const router = useRouter()
  const [values, setValues] = useState<Record<string, Value>>(initialAnswers)
  const [revision, setRevision] = useState(initialRevision)
  const [savedText, setSavedText] = useState<string | null>(initialSavedText)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<'save' | 'submit' | null>(null)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)
  const [unknown, setUnknown] = useState(false)
  const [badFields, setBadFields] = useState<readonly string[]>([])
  const [receipt, setReceipt] = useState<ReceiptView | null>(null)
  const [submittedVersion, setSubmittedVersion] = useState(initialSubmittedVersion)
  const dialog = useRef<HTMLDialogElement>(null)
  const requestIds = useRef({ save: newRequestId(), submit: newRequestId() })

  const readOnly = !editable || conflict !== null

  function set(key: string, value: Value) {
    setValues((v) => ({ ...v, [key]: value }))
    setDirty(true)
    setBadFields((f) => f.filter((k) => k !== key))
    // 內容變了就是新的一次儲存／送出，換新的請求編號（舊編號配新內容會被當成 REQUEST_MISMATCH）。
    requestIds.current = { save: newRequestId(), submit: newRequestId() }
    setUnknown(false)
  }

  /** 存草稿；回傳存好之後的版本號（失敗回 null，訊息已經顯示）。 */
  async function save(): Promise<number | null> {
    const result = await saveDraftAction(itemId, revision, values, requestIds.current.save)
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
      if ((await save()) !== null) setMessage({ tone: 'ok', text: '草稿已存到伺服器；重新登入或換一台裝置打開都還在。' })
    } catch {
      setMessage({ tone: 'error', text: '連線中斷，草稿可能沒有存到；請再按一次「儲存草稿」。' })
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

  const status = busy === 'save' ? '儲存中…' : busy === 'submit' ? '送出中…' : dirty ? '有未儲存的修改' : savedText ? `已儲存 ${savedText}` : '尚未儲存'

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

      {fields.map((field) => (
        <FieldInput
          key={field.key}
          field={field}
          value={values[field.key]}
          readOnly={readOnly}
          bad={badFields.includes(field.key)}
          filePendingMessage={filePendingMessage}
          onChange={(v) => set(field.key, v)}
        />
      ))}

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
              {submittedVersion ? '重新送出' : '正式送出'}
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

/** 收件章回執（原型 `ReceiptStamp`）：印章感的「已收件」＋版本、送出者、收件時間、回執編號。 */
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
        <dd className="font-semibold">{receipt.submittedByName}</dd>
        <dt className="text-muted-foreground">收件時間</dt>
        <dd className="font-semibold tabular-nums">{receipt.receivedText}（臺灣時間）</dd>
        <dt className="text-muted-foreground">欄位版本</dt>
        <dd className="tabular-nums">v{receipt.schemaVersionNo}</dd>
        <dt className="text-muted-foreground">回執編號</dt>
        <dd className="break-all font-mono text-xs">{receipt.receiptNo}</dd>
      </dl>
      <p className="text-xs text-muted-foreground">截止前可重送，以最後一次為準。每一次的回執都記在「繳交歷史」。</p>
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

function FieldInput({
  field,
  value,
  readOnly,
  bad,
  filePendingMessage,
  onChange,
}: {
  field: FormField
  value: Value | undefined
  readOnly: boolean
  bad: boolean
  filePendingMessage: string
  onChange: (value: Value) => void
}) {
  const id = `field-${field.key}`
  const text = typeof value === 'string' ? value : ''
  const picked = Array.isArray(value) ? value : []
  const border = bad ? 'border-danger' : 'border-border'
  const aria = { 'aria-invalid': bad || undefined, 'aria-required': field.required || undefined }
  const label = (
    <label htmlFor={id} className="block text-sm font-medium text-ink">
      {field.label}
      {field.required ? (
        <span className="ml-1 text-danger" aria-hidden>
          *
        </span>
      ) : null}
      {field.help ? <span className="ml-2 text-xs font-normal text-muted-foreground">{field.help}</span> : null}
    </label>
  )

  switch (field.type) {
    case 'heading':
      return <h3 className="border-b border-border pb-2 pt-2 text-base font-semibold text-ink">{field.label}</h3>
    case 'paragraph':
      return <p className="border-l-[3px] border-border pl-3 text-sm leading-relaxed text-muted-foreground">{field.label}</p>
    case 'file':
      return (
        <div>
          {label}
          <p id={id} tabIndex={-1} className={cn('mt-1 rounded-md border border-dashed bg-muted px-3 py-3 text-sm text-muted-foreground', border)}>
            {filePendingMessage}
          </p>
        </div>
      )
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
