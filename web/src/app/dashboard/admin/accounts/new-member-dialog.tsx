'use client'
import { IconPlus } from '@tabler/icons-react'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { CohortFilterOption } from '@/application/accounts'
import { cn } from '@/shared/cn'
import { createMemberAction, type MemberCreation } from './member-actions'
import { BUTTON, DIALOG, ErrorNote, INPUT, PRIMARY, SECONDARY, useDialog, type FieldError } from './temporary-password-dialog'

/**
 * 「新增成員」對話框（C 階段規格② §3.7）：第一步選學生、老師或管理員，再填欄位。
 *
 * 三種都直接開通、不問核實方式、不發臨時密碼：建好後系統寄一封「請設定密碼」信，本人用信裡的連結
 * 設定密碼（收不到的人，再用列上的「發臨時密碼」）。規則都在伺服器（Email 不能重複、同屆學號不能重複）。
 */

type Kind = 'student' | 'teacher' | 'admin'

const KINDS: readonly { readonly value: Kind; readonly label: string; readonly hint: string }[] = [
  { value: 'student', label: '學生', hint: '要填學號和屆別，建好就是已核准的學生' },
  { value: 'teacher', label: '老師', hint: '不需要學號，也不用等審核' },
  { value: 'admin', label: '管理員', hint: '先建成老師，再直接設為管理員' },
]

const KIND_LABEL: Record<Kind, string> = { student: '學生', teacher: '老師', admin: '管理員' }

export function NewMemberDialog({ cohorts }: { cohorts: readonly CohortFilterOption[] }) {
  const router = useRouter()
  const dialog = useDialog()
  const [kind, setKind] = useState<Kind>('student')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [studentNo, setStudentNo] = useState('')
  const [cohortId, setCohortId] = useState('')
  const [error, setError] = useState<FieldError>(null)
  const [busy, setBusy] = useState(false)
  const [requestId, setRequestId] = useState('')
  const [done, setDone] = useState<MemberCreation | null>(null)

  function open() {
    setKind('student')
    setName('')
    setEmail('')
    setStudentNo('')
    setCohortId('')
    setError(null)
    setDone(null)
    setRequestId(crypto.randomUUID())
    dialog.show()
  }

  function onClosed() {
    dialog.onClosed()
    if (done) {
      setDone(null)
      router.refresh()
    }
  }

  function edit<T>(set: (value: T) => void) {
    return (value: T) => {
      set(value)
      setError(null)
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await createMemberAction({ kind, name, email, studentNo, cohortId, requestId })
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
      <dialog ref={dialog.ref} onClose={onClosed} aria-label="新增成員" className={DIALOG}>
        <div className="max-h-[85vh] overflow-y-auto p-5">
          {!dialog.isOpen ? null : done ? (
            <div className="space-y-3" role="status">
              <p className="inline-block rounded-full bg-primary-subtle px-3 py-1 text-sm font-medium text-primary-on-subtle">
                已新增{KIND_LABEL[done.kind]}
              </p>
              <h2 className="text-lg font-extrabold text-foreground">{done.name}</h2>
              {done.setupMailRequested === false ? null : (
                <p className="text-sm text-muted-foreground">
                  {done.setupMailRequested === null
                    ? `${done.email} 已經建好了（這個請求之前就送出過，不會重複建立或重寄信）。`
                    : `已寄「請設定密碼」信到 ${done.email}，連結 30 分鐘內有效；他設好密碼就能登入。`}
                </p>
              )}
              {done.notice ? (
                <p role="alert" className="rounded-lg bg-primary-subtle px-3 py-2 text-sm text-primary-on-subtle">
                  {done.notice}
                </p>
              ) : null}
              <div className="flex justify-end">
                <button type="button" onClick={dialog.close} className={cn(BUTTON, SECONDARY)}>
                  關閉
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4" noValidate>
              <div>
                <h2 className="text-lg font-extrabold text-foreground">新增成員</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  系辦親手加的人直接開通，不用等審核；建好後系統會寄「請設定密碼」信給他。
                </p>
              </div>

              <fieldset className="grid gap-2 sm:grid-cols-3">
                <legend className="mb-1 text-sm font-medium text-foreground">身分</legend>
                {KINDS.map(({ value, label, hint }) => (
                  <label
                    key={value}
                    className={cn(
                      'flex cursor-pointer flex-col gap-0.5 rounded-lg border px-3 py-2 text-sm',
                      kind === value ? 'border-primary bg-primary-subtle/40' : 'border-border',
                    )}
                  >
                    <span className="flex items-center gap-2 font-medium text-foreground">
                      <input type="radio" name="member-kind" value={value} checked={kind === value} onChange={() => edit(setKind)(value)} />
                      {label}
                    </span>
                    <span className="text-xs text-muted-foreground">{hint}</span>
                  </label>
                ))}
              </fieldset>

              <label className="block text-sm font-medium text-foreground">
                姓名
                <input
                  value={name}
                  onChange={(e) => edit(setName)(e.target.value)}
                  aria-invalid={error?.field === 'name' || undefined}
                  autoComplete="off"
                  className={INPUT}
                />
              </label>
              <label className="block text-sm font-medium text-foreground">
                登入 Email
                <input
                  type="email"
                  value={email}
                  onChange={(e) => edit(setEmail)(e.target.value)}
                  aria-invalid={error?.field === 'email' || undefined}
                  autoComplete="off"
                  className={INPUT}
                />
              </label>

              {kind === 'student' ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="block text-sm font-medium text-foreground">
                    學號
                    <input
                      value={studentNo}
                      onChange={(e) => edit(setStudentNo)(e.target.value)}
                      aria-invalid={error?.field === 'studentNo' || undefined}
                      autoComplete="off"
                      className={INPUT}
                    />
                  </label>
                  <label className="block text-sm font-medium text-foreground">
                    屆別
                    <select
                      value={cohortId}
                      onChange={(e) => edit(setCohortId)(e.target.value)}
                      aria-invalid={error?.field === 'cohortId' || undefined}
                      className={INPUT}
                    >
                      <option value="">請選屆別</option>
                      {cohorts.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}（{c.code}）
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              ) : null}

              <ErrorNote error={error} />

              <div className="flex justify-end gap-2">
                <button type="button" onClick={dialog.close} className={cn(BUTTON, SECONDARY)} disabled={busy}>
                  取消
                </button>
                <button type="submit" className={cn(BUTTON, PRIMARY)} disabled={busy}>
                  {busy ? '處理中…' : `新增${KIND_LABEL[kind]}`}
                </button>
              </div>
            </form>
          )}
        </div>
      </dialog>
    </>
  )
}
