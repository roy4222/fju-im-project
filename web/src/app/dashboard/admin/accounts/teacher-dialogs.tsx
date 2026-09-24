'use client'
import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { AccountLookup, TeacherAccountReceipt, VerificationMethod } from '@/application/accounts'
import { cn } from '@/shared/cn'
import { createTeacherAction, issueTemporaryPasswordAction, lookupAccountAction } from './actions'

/**
 * 新增老師、發臨時密碼兩個對話框（票 8；原型 `/dashboard/admin/accounts` 的「新增帳號」與
 * 「重設臨時密碼」）。
 *
 * 規則都在伺服器（核實方式必選、Email 不能重複、不能替自己發、停用的帳號不能發）；
 * 這裡只做「還沒選核實方式就不送」這種省一次來回的提示。
 *
 * **臨時密碼只顯示一次**：它只活在這個對話框的 state 裡，關掉就清掉；不寫進網址、
 * 不寫進 localStorage、頁面重新整理也拿不回來（伺服器沒有存可讀的版本）。
 */

export type VerificationLabels = {
  readonly methods: readonly VerificationMethod[]
  readonly methodLabel: Record<VerificationMethod, string>
  readonly noteRequired: Record<VerificationMethod, boolean>
  readonly noteHint: Record<VerificationMethod, string>
}

const BUTTON =
  'inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50'
const PRIMARY = 'bg-primary text-primary-foreground hover:bg-primary/90'
const SECONDARY = 'bg-muted text-foreground hover:bg-border'
const INPUT = 'mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-normal'
const DIALOG =
  'm-auto w-[min(34rem,calc(100vw-2rem))] rounded-card border border-border bg-background p-0 backdrop:bg-ink/40'

type FieldError = { message: string; field?: string } | null

function ErrorNote({ error }: { error: FieldError }) {
  if (!error) return null
  return (
    <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
      {error.message}
    </p>
  )
}

/** 核實方式（跟註冊核准同一套選項；班代協助聯絡不能單獨作為依據，所以沒有那個選項）。 */
function VerificationFields({
  name,
  labels,
  method,
  note,
  onMethod,
  onNote,
  error,
}: {
  name: string
  labels: VerificationLabels
  method: VerificationMethod | ''
  note: string
  onMethod: (m: VerificationMethod) => void
  onNote: (v: string) => void
  error: FieldError
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-ink">
        怎麼確認是本人 <span className="font-normal text-muted-foreground">・必選，會寫進操作紀錄</span>
      </legend>
      {labels.methods.map((m) => (
        <label key={m} className="flex items-start gap-2 text-sm text-ink">
          <input type="radio" name={name} value={m} checked={method === m} onChange={() => onMethod(m)} className="mt-1" />
          {labels.methodLabel[m]}
        </label>
      ))}
      {method ? (
        <label className="block text-sm font-medium text-ink">
          核實說明
          <span className="ml-1 font-normal text-muted-foreground">・{labels.noteHint[method]}</span>
          <textarea
            rows={2}
            value={note}
            onChange={(e) => onNote(e.target.value)}
            aria-invalid={error?.field === 'verificationNote' || undefined}
            required={labels.noteRequired[method]}
            className={INPUT}
          />
        </label>
      ) : null}
    </fieldset>
  )
}

/** 臨時密碼只顯示一次的那一格。 */
function SecretBox({ secret }: { secret: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-4 py-3">
      <code data-testid="temporary-password" className="flex-1 break-all text-left text-lg font-semibold tracking-wider text-ink">
        {secret}
      </code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(secret).then(() => setCopied(true), () => undefined)
        }}
        className={cn(BUTTON, SECONDARY, 'px-3 py-1.5')}
      >
        {copied ? '已複製' : '複製'}
      </button>
    </div>
  )
}

function useDialog() {
  const ref = useRef<HTMLDialogElement>(null)
  // 關著的時候不渲染內容：臨時密碼只能活在「開著的那一次」。
  const [isOpen, setIsOpen] = useState(false)
  return {
    ref,
    isOpen,
    show() {
      setIsOpen(true)
      ref.current?.showModal()
    },
    close() {
      ref.current?.close()
    },
    onClosed() {
      setIsOpen(false)
    },
  }
}

// ── 新增老師 ────────────────────────────────────────────────────────────────

type Mode = 'direct' | 'preauthorize'

export function NewTeacherDialog({ labels }: { labels: VerificationLabels }) {
  const router = useRouter()
  const dialog = useDialog()
  const [mode, setMode] = useState<Mode>('direct')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [method, setMethod] = useState<VerificationMethod | ''>('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<FieldError>(null)
  const [busy, setBusy] = useState(false)
  const [requestId, setRequestId] = useState('')
  const [done, setDone] = useState<{ account: TeacherAccountReceipt; temporaryPassword: string | null } | null>(null)

  function open() {
    setMode('direct')
    setName('')
    setEmail('')
    setMethod('')
    setNote('')
    setError(null)
    setDone(null)
    setRequestId(crypto.randomUUID())
    dialog.show()
  }

  function onClosed() {
    dialog.onClosed()
    // 臨時密碼跟著對話框一起丟掉。
    if (done) {
      setDone(null)
      router.refresh()
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (mode === 'direct' && !method) {
      setError({ message: '直接新增會發臨時密碼，請選擇怎麼確認是本人。', field: 'verificationMethod' })
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await createTeacherAction({
        mode,
        email,
        name,
        verificationMethod: mode === 'direct' ? method : '',
        verificationNote: mode === 'direct' ? note : '',
        requestId,
      })
      if (result.ok) setDone(result.data)
      else setError({ message: result.message, field: result.field })
    } catch {
      setError({ message: '結果未知：可能已經建好了。請再按一次（不會重複建立），或關閉後重新整理。' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button type="button" onClick={open} className={cn(BUTTON, PRIMARY)}>
        新增老師
      </button>
      <dialog ref={dialog.ref} onClose={onClosed} aria-label="新增老師" className={DIALOG}>
        <div className="max-h-[85vh] overflow-y-auto p-5">
          {!dialog.isOpen ? null : done ? (
            <div className="space-y-3" role="status">
              <p className="inline-block rounded-full bg-primary-subtle px-3 py-1 text-sm font-medium text-primary-on-subtle">
                {done.account.mode === 'direct' ? '已建立' : '已建立預授權'}
              </p>
              <h2 className="text-lg font-semibold text-ink">{done.account.name ?? done.account.email}</h2>
              {done.account.mode === 'preauthorize' ? (
                <p className="text-sm text-muted-foreground">
                  {done.account.email} 已經保留給這位老師，別人不能拿它註冊。老師第一次登入時補姓名與聯絡資料；
                  需要用密碼登入時，按「發臨時密碼」核發。
                </p>
              ) : done.temporaryPassword ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    臨時密碼<strong className="text-ink">只顯示這一次</strong>，關掉就查不到。請交給老師本人；
                    老師用 {done.account.email} 登入後必須先改密碼，再補聯絡資料。
                  </p>
                  <SecretBox secret={done.temporaryPassword} />
                </>
              ) : (
                <p role="alert" className="rounded-md bg-primary-subtle px-3 py-2 text-sm text-primary-on-subtle">
                  帳號已經建好了，但這組臨時密碼無法再顯示。請關閉後按「發臨時密碼」重新核發（舊的那組會失效）。
                </p>
              )}
              <div className="flex justify-end">
                <button type="button" onClick={dialog.close} className={cn(BUTTON, SECONDARY)}>
                  關閉
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4" noValidate>
              <div>
                <h2 className="text-lg font-semibold text-ink">新增老師</h2>
                <p className="mt-1 text-sm text-muted-foreground">老師不需要學號，也不用等審核。系統不存可查看的密碼。</p>
              </div>

              <fieldset className="grid gap-2 sm:grid-cols-2">
                <legend className="mb-1 text-sm font-medium text-ink">新增方式</legend>
                {(
                  [
                    ['direct', '直接新增', '現在發一次性臨時密碼，老師用 Email＋密碼登入'],
                    ['preauthorize', '只用 Email 預授權', '先保留這個 Email，老師之後登入再補資料'],
                  ] as const
                ).map(([value, label, hint]) => (
                  <label
                    key={value}
                    className={cn(
                      'flex cursor-pointer flex-col gap-0.5 rounded-md border px-3 py-2 text-sm',
                      mode === value ? 'border-primary bg-primary-subtle/40' : 'border-border',
                    )}
                  >
                    <span className="flex items-center gap-2 font-medium text-ink">
                      <input type="radio" name="teacher-mode" value={value} checked={mode === value} onChange={() => setMode(value)} />
                      {label}
                    </span>
                    <span className="text-xs text-muted-foreground">{hint}</span>
                  </label>
                ))}
              </fieldset>

              <label className="block text-sm font-medium text-ink">
                登入 Email
                <input
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value)
                    setError(null)
                  }}
                  aria-invalid={error?.field === 'email' || undefined}
                  autoComplete="off"
                  className={INPUT}
                />
              </label>
              <label className="block text-sm font-medium text-ink">
                姓名{mode === 'preauthorize' ? <span className="font-normal text-muted-foreground">・選填，老師登入後會自己補</span> : null}
                <input
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value)
                    setError(null)
                  }}
                  aria-invalid={error?.field === 'name' || undefined}
                  autoComplete="off"
                  className={INPUT}
                />
              </label>

              {mode === 'direct' ? (
                <VerificationFields
                  name="teacher-method"
                  labels={labels}
                  method={method}
                  note={note}
                  onMethod={(m) => {
                    setMethod(m)
                    setError(null)
                  }}
                  onNote={(v) => {
                    setNote(v)
                    setError(null)
                  }}
                  error={error}
                />
              ) : null}

              <ErrorNote error={error} />

              <div className="flex justify-end gap-2">
                <button type="button" onClick={dialog.close} className={cn(BUTTON, SECONDARY)} disabled={busy}>
                  取消
                </button>
                <button type="submit" className={cn(BUTTON, PRIMARY)} disabled={busy}>
                  {busy ? '處理中…' : mode === 'direct' ? '建立並產生臨時密碼' : '建立預授權'}
                </button>
              </div>
            </form>
          )}
        </div>
      </dialog>
    </>
  )
}

// ── 發臨時密碼 ──────────────────────────────────────────────────────────────

const ROLE_LABEL = { student: '學生', teacher: '老師', admin: '系辦' } as const
const STATUS_LABEL = { pending: '待審核', active: '正常', disabled: '已停用', deidentified: '已去識別化' } as const

/**
 * 替任一帳號核發一次性臨時密碼。
 *
 * 帳號列表由票 9 做；在那之前先用登入 Email 查人。票 9 在每一列放這個對話框時，
 * 傳 `target` 就會跳過查詢那一步。
 */
export function TemporaryPasswordDialog({
  labels,
  target: presetTarget,
}: {
  labels: VerificationLabels
  target?: AccountLookup
}) {
  const dialog = useDialog()
  const [lookupEmail, setLookupEmail] = useState('')
  const [target, setTarget] = useState<AccountLookup | null>(presetTarget ?? null)
  const [method, setMethod] = useState<VerificationMethod | ''>('')
  const [note, setNote] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<FieldError>(null)
  const [busy, setBusy] = useState(false)
  const [requestId, setRequestId] = useState('')
  const [done, setDone] = useState<{ temporaryPassword: string | null } | null>(null)

  function open() {
    setLookupEmail('')
    setTarget(presetTarget ?? null)
    setMethod('')
    setNote('')
    setReason('')
    setError(null)
    setDone(null)
    setRequestId(crypto.randomUUID())
    dialog.show()
  }

  function onClosed() {
    dialog.onClosed()
    setDone(null)
  }

  /** 「重新核發」：換一個請求編號，舊的那組會失效。 */
  function reissue() {
    setDone(null)
    setMethod('')
    setNote('')
    setReason('')
    setError(null)
    setRequestId(crypto.randomUUID())
  }

  async function lookup(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await lookupAccountAction({ email: lookupEmail })
      if (result.ok) setTarget(result.data)
      else setError({ message: result.message, field: result.field })
    } catch {
      setError({ message: '查詢失敗，請再試一次。' })
    } finally {
      setBusy(false)
    }
  }

  async function issue(e: React.FormEvent) {
    e.preventDefault()
    if (!target) return
    if (!method) {
      setError({ message: '請選擇怎麼確認是本人。發臨時密碼前一定要核實本人。', field: 'verificationMethod' })
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await issueTemporaryPasswordAction({
        userId: target.userId,
        verificationMethod: method,
        verificationNote: note,
        reason,
        requestId,
      })
      if (result.ok) setDone({ temporaryPassword: result.data.temporaryPassword })
      else setError({ message: result.message, field: result.field })
    } catch {
      setError({ message: '結果未知：可能已經核發。請再按一次確認（同一次不會重複核發）；密碼若拿不回來就重新核發。' })
    } finally {
      setBusy(false)
    }
  }

  const unusable = target ? target.status === 'disabled' || target.status === 'deidentified' : false

  return (
    <>
      <button
        type="button"
        onClick={open}
        className={cn(BUTTON, SECONDARY)}
        aria-label={presetTarget ? `發臨時密碼給 ${presetTarget.name}` : undefined}
      >
        發臨時密碼
      </button>
      <dialog ref={dialog.ref} onClose={onClosed} aria-label="發臨時密碼" className={DIALOG}>
        <div className="max-h-[85vh] overflow-y-auto p-5">
          {!dialog.isOpen ? null : done ? (
            <div className="space-y-3" role="status">
              <p className="inline-block rounded-full bg-primary-subtle px-3 py-1 text-sm font-medium text-primary-on-subtle">
                已核發
              </p>
              <h2 className="text-lg font-semibold text-ink">{target?.name} 的臨時密碼</h2>
              {done.temporaryPassword ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    <strong className="text-ink">只顯示這一次</strong>，關掉就查不到。舊密碼已經失效，舊的登入也會被登出；
                    本人用這組登入後必須先改密碼。核實方式與操作者、時間已寫入紀錄。
                  </p>
                  <SecretBox secret={done.temporaryPassword} />
                </>
              ) : (
                <p role="alert" className="rounded-md bg-primary-subtle px-3 py-2 text-sm text-primary-on-subtle">
                  這次已經核發過了，但密碼無法再顯示。要的話請重新核發，舊的那組會失效。
                </p>
              )}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={reissue} className={cn(BUTTON, SECONDARY)}>
                  重新核發
                </button>
                <button type="button" onClick={dialog.close} className={cn(BUTTON, PRIMARY)}>
                  關閉
                </button>
              </div>
            </div>
          ) : !target ? (
            <form onSubmit={lookup} className="space-y-4" noValidate>
              <div>
                <h2 className="text-lg font-semibold text-ink">發臨時密碼</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  系統不存可查看的密碼，只能核發一組新的一次性密碼。先用登入 Email 找到這個帳號。
                </p>
              </div>
              <label className="block text-sm font-medium text-ink">
                登入 Email
                <input
                  type="email"
                  value={lookupEmail}
                  onChange={(e) => {
                    setLookupEmail(e.target.value)
                    setError(null)
                  }}
                  aria-invalid={error?.field === 'email' || undefined}
                  autoComplete="off"
                  className={INPUT}
                />
              </label>
              <ErrorNote error={error} />
              <div className="flex justify-end gap-2">
                <button type="button" onClick={dialog.close} className={cn(BUTTON, SECONDARY)} disabled={busy}>
                  取消
                </button>
                <button type="submit" className={cn(BUTTON, PRIMARY)} disabled={busy}>
                  {busy ? '查詢中…' : '查詢'}
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={issue} className="space-y-4" noValidate>
              <div>
                <h2 className="text-lg font-semibold text-ink">發臨時密碼給 {target.name}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  舊密碼會立刻失效、舊的登入會被登出；新的一次性密碼只顯示一次，本人登入後必須改密碼。
                </p>
              </div>
              <dl className="grid grid-cols-[4.5rem_1fr] gap-y-1 rounded-md bg-muted px-4 py-3 text-sm">
                <dt className="text-muted-foreground">帳號</dt>
                <dd className="break-all font-medium text-ink">{target.email}</dd>
                <dt className="text-muted-foreground">角色</dt>
                <dd className="font-medium text-ink">
                  {target.roles.length ? target.roles.map((r) => ROLE_LABEL[r]).join('、') : '尚無（待審核）'}
                </dd>
                <dt className="text-muted-foreground">狀態</dt>
                <dd className="font-medium text-ink">{STATUS_LABEL[target.status]}</dd>
              </dl>
              {unusable ? (
                <p role="note" className="rounded-md bg-primary-subtle px-3 py-2 text-sm text-primary-on-subtle">
                  這個帳號已停用，登不進來；要發臨時密碼請先還原帳號。
                </p>
              ) : (
                <>
                  <VerificationFields
                    name="temp-method"
                    labels={labels}
                    method={method}
                    note={note}
                    onMethod={(m) => {
                      setMethod(m)
                      setError(null)
                    }}
                    onNote={(v) => {
                      setNote(v)
                      setError(null)
                    }}
                    error={error}
                  />
                  <label className="block text-sm font-medium text-ink">
                    理由 <span className="font-normal text-muted-foreground">・選填，例如「忘記密碼，9/24 到系辦」</span>
                    <textarea
                      rows={2}
                      value={reason}
                      onChange={(e) => {
                        setReason(e.target.value)
                        setError(null)
                      }}
                      aria-invalid={error?.field === 'reason' || undefined}
                      className={INPUT}
                    />
                  </label>
                </>
              )}
              <ErrorNote error={error} />
              <div className="flex justify-end gap-2">
                <button type="button" onClick={dialog.close} className={cn(BUTTON, SECONDARY)} disabled={busy}>
                  取消
                </button>
                {!presetTarget ? (
                  <button
                    type="button"
                    onClick={() => {
                      setTarget(null)
                      setError(null)
                    }}
                    className={cn(BUTTON, SECONDARY)}
                    disabled={busy}
                  >
                    換一個帳號
                  </button>
                ) : null}
                <button type="submit" className={cn(BUTTON, PRIMARY)} disabled={busy || unusable}>
                  {busy ? '處理中…' : '產生一次性密碼'}
                </button>
              </div>
            </form>
          )}
        </div>
      </dialog>
    </>
  )
}
