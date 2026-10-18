'use client'
import { IconPlus } from '@tabler/icons-react'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { TeacherAccountReceipt, VerificationMethod } from '@/application/accounts'
import { cn } from '@/shared/cn'
import { createTeacherAction } from './actions'
import {
  BUTTON,
  DIALOG,
  ErrorNote,
  INPUT,
  PRIMARY,
  SECONDARY,
  SecretBox,
  useDialog,
  VerificationFields,
  type FieldError,
  type VerificationLabels,
} from './temporary-password-dialog'

/**
 * 「新增成員」對話框（C 階段規格② §3.7；C2-07 從 `teacher-dialogs.tsx` 的 `NewTeacherDialog` 拆出）。
 *
 * 目前只開老師表單（直接新增發臨時密碼，或先用 Email 預授權），學生／老師／管理員三選一由 C2-09 補上。
 * 規則都在伺服器（核實方式必選、Email 不能重複）；臨時密碼只活在這個對話框開著的那一次。
 */

type Mode = 'direct' | 'preauthorize'

export function NewMemberDialog({ labels }: { labels: VerificationLabels }) {
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
        <IconPlus aria-hidden />
        新增成員
      </button>
      <dialog ref={dialog.ref} onClose={onClosed} aria-label="新增老師" className={DIALOG}>
        <div className="max-h-[85vh] overflow-y-auto p-5">
          {!dialog.isOpen ? null : done ? (
            <div className="space-y-3" role="status">
              <p className="inline-block rounded-full bg-primary-subtle px-3 py-1 text-sm font-medium text-primary-on-subtle">
                {done.account.mode === 'direct' ? '已建立' : '已預先建立老師帳號'}
              </p>
              <h2 className="text-lg font-extrabold text-foreground">{done.account.name ?? done.account.email}</h2>
              {done.account.mode === 'preauthorize' ? (
                <p className="text-sm text-muted-foreground">
                  {done.account.email} 已經保留給這位老師，別人不能拿它註冊。老師第一次登入時補姓名與聯絡資料；
                  需要用密碼登入時，按「發臨時密碼」核發。
                </p>
              ) : done.temporaryPassword ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    臨時密碼<strong className="text-foreground">只顯示這一次</strong>，關掉就查不到。請交給老師本人；
                    老師用 {done.account.email} 登入後必須先改密碼，再補聯絡資料。
                  </p>
                  <SecretBox secret={done.temporaryPassword} />
                </>
              ) : (
                <p role="alert" className="rounded-lg bg-primary-subtle px-3 py-2 text-sm text-primary-on-subtle">
                  帳號已經建好了，但這組臨時密碼無法再顯示。請關閉後按「發臨時密碼」重新核發（舊的那組就不能再登入）。
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
                <h2 className="text-lg font-extrabold text-foreground">新增老師</h2>
                <p className="mt-1 text-sm text-muted-foreground">老師不需要學號，也不用等審核。系統不存可查看的密碼。</p>
              </div>

              <fieldset className="grid gap-2 sm:grid-cols-2">
                <legend className="mb-1 text-sm font-medium text-foreground">新增方式</legend>
                {(
                  [
                    ['direct', '直接新增', '現在發一次性臨時密碼，老師用 Email＋密碼登入'],
                    ['preauthorize', '只用 Email 預先建立', '先保留這個 Email，老師之後登入再補資料'],
                  ] as const
                ).map(([value, label, hint]) => (
                  <label
                    key={value}
                    className={cn(
                      'flex cursor-pointer flex-col gap-0.5 rounded-lg border px-3 py-2 text-sm',
                      mode === value ? 'border-primary bg-primary-subtle/40' : 'border-border',
                    )}
                  >
                    <span className="flex items-center gap-2 font-medium text-foreground">
                      <input type="radio" name="teacher-mode" value={value} checked={mode === value} onChange={() => setMode(value)} />
                      {label}
                    </span>
                    <span className="text-xs text-muted-foreground">{hint}</span>
                  </label>
                ))}
              </fieldset>

              <label className="block text-sm font-medium text-foreground">
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
              <label className="block text-sm font-medium text-foreground">
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
                  kind="teacher"
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
                  {busy ? '處理中…' : mode === 'direct' ? '建立並產生臨時密碼' : '預先建立帳號'}
                </button>
              </div>
            </form>
          )}
        </div>
      </dialog>
    </>
  )
}
