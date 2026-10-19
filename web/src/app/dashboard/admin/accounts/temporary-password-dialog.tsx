'use client'
import { IconKey } from '@tabler/icons-react'
import { useRef, useState } from 'react'
import type { AccountLookup, VerificationMethod } from '@/application/accounts'
import { cn } from '@/shared/cn'
import { issueTemporaryPasswordAction, lookupAccountAction } from './actions'

/**
 * 發臨時密碼對話框（票 8；原型 `/dashboard/admin/accounts` 的「重設臨時密碼」），以及它跟「新增成員」
 * （`new-member-dialog.tsx`）共用的核實欄位、臨時密碼框、對話框外觀（C2-07 從 `teacher-dialogs.tsx` 拆出）。
 *
 * 規則都在伺服器（Email 不能重複、不能替自己發、停用的帳號不能發）。系辦發臨時密碼不再問「怎麼確認是本人」（C2-11；
 * 伺服器一律記 `office_review`）；理由選填。核實欄位只剩「新增成員」那邊還在用。
 *
 * **臨時密碼只顯示一次**：它只活在這個對話框的 state 裡，關掉就清掉；不寫進網址、
 * 不寫進 localStorage、頁面重新整理也拿不回來（伺服器沒有存可讀的版本）。
 */

export type VerificationLabels = {
  readonly methods: readonly VerificationMethod[]
  readonly methodLabel: Record<VerificationMethod, string>
  readonly noteRequired: Record<VerificationMethod, boolean>
  readonly noteHint: Record<VerificationMethod, string>
  /** 對象是老師或職員時的選項文字與提示（不提學生證；T6 系5）。 */
  readonly teacherMethodLabel: Record<VerificationMethod, string>
  readonly teacherNoteHint: Record<VerificationMethod, string>
}

type VerificationKind = 'student' | 'teacher'

export const BUTTON =
  // 外觀照原型（票 36）：h-10、圓角、粗一點的字；主要動作系網橘、次要白底細框、危險淡紅。
  'press inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4'
export const PRIMARY = 'btn-fju rounded-[4px]'
export const SECONDARY = 'border border-border bg-background text-foreground hover:bg-muted'
export const INPUT =
  'mt-1.5 min-h-10 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-normal outline-none transition-[border-color,box-shadow] focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25'
export const DIALOG =
  'm-auto w-[min(34rem,calc(100vw-2rem))] rounded-xl border-0 bg-popover p-0 whitespace-normal ring-1 ring-foreground/10 backdrop:bg-black/10 backdrop:backdrop-blur-xs'

export type FieldError = { message: string; field?: string } | null

export function ErrorNote({ error }: { error: FieldError }) {
  if (!error) return null
  return (
    <p role="alert" className="rounded-lg bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
      {error.message}
    </p>
  )
}

/** 核實方式（跟註冊核准同一套選項；班代協助聯絡不能單獨作為依據，所以沒有那個選項）。對象是老師時換成不提學生證的文字。 */
export function VerificationFields({
  name,
  kind,
  labels,
  method,
  note,
  onMethod,
  onNote,
  error,
}: {
  name: string
  kind: VerificationKind
  labels: VerificationLabels
  method: VerificationMethod | ''
  note: string
  onMethod: (m: VerificationMethod) => void
  onNote: (v: string) => void
  error: FieldError
}) {
  const methodLabel = kind === 'teacher' ? labels.teacherMethodLabel : labels.methodLabel
  const noteHint = kind === 'teacher' ? labels.teacherNoteHint : labels.noteHint
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-foreground">
        怎麼確認是本人 <span className="font-normal text-muted-foreground">・必選，會寫進操作紀錄</span>
      </legend>
      {labels.methods.map((m) => (
        <label key={m} className="flex items-start gap-2 text-sm text-foreground">
          <input type="radio" name={name} value={m} checked={method === m} onChange={() => onMethod(m)} className="mt-1" />
          {methodLabel[m]}
        </label>
      ))}
      {method ? (
        <label className="block text-sm font-medium text-foreground">
          怎麼確認的說明
          <span className="ml-1 font-normal text-muted-foreground">・{noteHint[method]}</span>
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
export function SecretBox({ secret }: { secret: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-muted px-4 py-3">
      <code data-testid="temporary-password" className="flex-1 break-all text-left text-lg font-semibold tracking-wider text-foreground">
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

export function useDialog() {
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

// ── 發臨時密碼 ──────────────────────────────────────────────────────────────

const ROLE_LABEL = { student: '學生', teacher: '老師', admin: '系辦' } as const
const STATUS_LABEL = { pending: '待審核', active: '正常', disabled: '已停用', deidentified: '已刪除個人資料' } as const

/**
 * 替任一帳號核發一次性臨時密碼。
 *
 * 帳號列表由票 9 做；在那之前先用登入 Email 查人。票 9 在每一列放這個對話框時，
 * 傳 `target` 就會跳過查詢那一步。
 */
export function TemporaryPasswordDialog({
  target: presetTarget,
  triggerLabel,
}: {
  target?: AccountLookup
  /** 觸發鈕的字；預設「發臨時密碼」。寄重設密碼信的視窗裡用「收不到信？改發臨時密碼」。 */
  triggerLabel?: string
}) {
  const dialog = useDialog()
  const [lookupEmail, setLookupEmail] = useState('')
  const [target, setTarget] = useState<AccountLookup | null>(presetTarget ?? null)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<FieldError>(null)
  const [busy, setBusy] = useState(false)
  const [requestId, setRequestId] = useState('')
  const [done, setDone] = useState<{ temporaryPassword: string | null } | null>(null)

  function open() {
    setLookupEmail('')
    setTarget(presetTarget ?? null)
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

  /** 「重新核發」：換一個請求編號，舊的那組就不能再登入。 */
  function reissue() {
    setDone(null)
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
    setBusy(true)
    setError(null)
    try {
      const result = await issueTemporaryPasswordAction({
        userId: target.userId,
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
        className={cn(
          BUTTON,
          SECONDARY,
          presetTarget ? 'h-7 border-transparent bg-transparent px-2.5 text-[0.8rem] font-medium hover:bg-muted' : undefined,
        )}
        aria-label={presetTarget && !triggerLabel ? `發臨時密碼給 ${presetTarget.name}` : undefined}
      >
        <IconKey aria-hidden />
        {triggerLabel ?? '發臨時密碼'}
      </button>
      <dialog ref={dialog.ref} onClose={onClosed} aria-label="發臨時密碼" className={DIALOG}>
        <div className="max-h-[85vh] overflow-y-auto p-5">
          {!dialog.isOpen ? null : done ? (
            <div className="space-y-3" role="status">
              <p className="inline-block rounded-full bg-primary-subtle px-3 py-1 text-sm font-medium text-primary-on-subtle">
                已核發
              </p>
              <h2 className="text-lg font-extrabold text-foreground">{target?.name} 的臨時密碼</h2>
              {done.temporaryPassword ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    <strong className="text-foreground">只顯示這一次</strong>，關掉就查不到。舊密碼不能再登入，舊的登入也會被登出；
                    本人用這組登入後必須先改密碼。操作者與時間都已寫入紀錄。
                  </p>
                  <SecretBox secret={done.temporaryPassword} />
                </>
              ) : (
                <p role="alert" className="rounded-lg bg-primary-subtle px-3 py-2 text-sm text-primary-on-subtle">
                  這次已經核發過了，但密碼無法再顯示。要的話請重新核發，舊的那組就不能再登入。
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
                <h2 className="text-lg font-extrabold text-foreground">發臨時密碼</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  系統不存可查看的密碼，只能核發一組新的一次性密碼。先用登入 Email 找到這個帳號。
                </p>
              </div>
              <label className="block text-sm font-medium text-foreground">
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
                <h2 className="text-lg font-extrabold text-foreground">發臨時密碼給 {target.name}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  舊密碼立刻不能再登入、舊的登入會被登出；新的一次性密碼只顯示一次，本人登入後必須改密碼。
                </p>
              </div>
              <dl className="grid grid-cols-[4.5rem_1fr] gap-y-1 rounded-lg bg-muted px-4 py-3 text-sm">
                <dt className="text-muted-foreground">帳號</dt>
                <dd className="break-all font-medium text-foreground">{target.email}</dd>
                <dt className="text-muted-foreground">角色</dt>
                <dd className="font-medium text-foreground">
                  {target.roles.length ? target.roles.map((r) => ROLE_LABEL[r]).join('、') : '尚無（待審核）'}
                </dd>
                <dt className="text-muted-foreground">狀態</dt>
                <dd className="font-medium text-foreground">{STATUS_LABEL[target.status]}</dd>
              </dl>
              {unusable ? (
                <p role="note" className="rounded-lg bg-primary-subtle px-3 py-2 text-sm text-primary-on-subtle">
                  這個帳號已停用，登不進來；要發臨時密碼請先還原帳號。
                </p>
              ) : (
                <>
                  <label className="block text-sm font-medium text-foreground">
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
