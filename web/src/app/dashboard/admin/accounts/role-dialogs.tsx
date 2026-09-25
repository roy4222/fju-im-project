'use client'
import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { OrphanRepairReceipt, OrphanRole, RoleChangeReceipt } from '@/application/accounts'
import { cn } from '@/shared/cn'
import { grantAdminAction, repairOrphanAction, revokeAdminAction } from './actions'

/**
 * 帳號列表每一列的「設為管理員／取消管理員」與孤兒帳號的「補建角色」（票 10b）。
 *
 * 跟停用對話框同一個樣子：先講影響、理由必填，送出後顯示回執；關掉對話框才刷新列表。
 * 規則都在伺服器（不能對自己、學生不能設、最後一位管理員、孤兒帳號的定義），這裡只把輸入送過去。
 */

const BUTTON =
  // 外觀照原型（票 36）：h-10、圓角、粗一點的字；主要動作系網橘、次要白底細框、危險淡紅。
  'press inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4'
const PRIMARY = 'btn-fju rounded-[4px]'
const SECONDARY = 'border border-border bg-background text-foreground hover:bg-muted'
const DANGER = 'bg-destructive/10 text-destructive hover:bg-destructive/20'
const DIALOG =
  'm-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl border-0 bg-popover p-0 ring-1 ring-foreground/10 backdrop:bg-black/10 backdrop:backdrop-blur-xs'

export type RoleTargetView = {
  readonly userId: string
  readonly name: string
  readonly loginEmail: string
  readonly rolesText: string
}

/** 共用的開關、requestId、送出狀態。每次打開換一個新的請求編號；結果未知時同一個編號再送不會重複做。 */
function useDialog<T>() {
  const router = useRouter()
  const ref = useRef<HTMLDialogElement>(null)
  const [isOpen, setIsOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [receipt, setReceipt] = useState<T | null>(null)
  const [requestId, setRequestId] = useState('')
  return {
    ref,
    isOpen,
    reason,
    setReason: (value: string) => {
      setReason(value)
      setError(null)
    },
    error,
    setError,
    busy,
    receipt,
    requestId,
    open() {
      setReason('')
      setError(null)
      setReceipt(null)
      setRequestId(crypto.randomUUID())
      setIsOpen(true)
      ref.current?.showModal()
    },
    close() {
      ref.current?.close()
    },
    onClosed() {
      setIsOpen(false)
      if (receipt) router.refresh()
    },
    async run(action: () => Promise<{ ok: true; data: T } | { ok: false; message: string }>, unknownText: string) {
      setBusy(true)
      setError(null)
      try {
        const result = await action()
        if (result.ok) setReceipt(result.data)
        else setError(result.message)
      } catch {
        setError(unknownText)
      } finally {
        setBusy(false)
      }
    },
  }
}

function AccountFacts({ account }: { account: RoleTargetView }) {
  return (
    <dl className="grid grid-cols-[5rem_1fr] gap-y-1.5 rounded-lg bg-muted px-4 py-3 text-sm">
      <dt className="text-muted-foreground">帳號</dt>
      <dd className="break-all font-medium text-foreground">{account.loginEmail}</dd>
      <dt className="text-muted-foreground">目前角色</dt>
      <dd className="font-medium text-foreground">{account.rolesText}</dd>
    </dl>
  )
}

function ReasonField({ value, onChange, placeholder, invalid }: { value: string; onChange: (v: string) => void; placeholder: string; invalid: boolean }) {
  return (
    <label className="block text-sm font-medium text-foreground">
      理由 <span className="font-normal text-muted-foreground">・必填，會寫入紀錄</span>
      <textarea
        rows={2}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-invalid={invalid ? true : undefined}
        className="mt-1.5 w-full rounded-lg border border-input bg-background px-3 py-2 outline-none transition-[border-color,box-shadow] focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25 text-sm font-normal"
      />
    </label>
  )
}

function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null
  return (
    <p role="alert" className="rounded-lg bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
      {error}
    </p>
  )
}

// ── 設為／取消管理員 ────────────────────────────────────────────────────────

export function AdminRoleDialog({ account, mode }: { account: RoleTargetView; mode: 'grant' | 'revoke' }) {
  const d = useDialog<RoleChangeReceipt>()
  const granting = mode === 'grant'
  const verb = granting ? '設為管理員' : '取消管理員'

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!d.reason.trim()) {
      d.setError('請寫理由。')
      return
    }
    const input = { userId: account.userId, reason: d.reason, requestId: d.requestId }
    await d.run(
      () => (granting ? grantAdminAction(input) : revokeAdminAction(input)),
      `結果未知：可能已經${verb}。請再按一次確認（不會重複做），或關閉後重新整理。`,
    )
  }

  return (
    <>
      <button type="button" onClick={d.open} className={cn(BUTTON, SECONDARY, 'h-7 border-transparent bg-transparent px-2.5 text-[0.8rem] font-medium hover:bg-muted')} aria-label={`${verb} ${account.name}`}>
        {verb}
      </button>
      <dialog ref={d.ref} onClose={d.onClosed} aria-label={`${verb} ${account.name}`} className={DIALOG}>
        <div className="p-5">
          {!d.isOpen ? null : d.receipt ? (
            <div className="space-y-3 text-center" role="status">
              <p className="inline-block rounded-full bg-primary-subtle px-3 py-1 text-sm font-medium text-primary-on-subtle">
                {d.receipt.granted ? '已設為管理員' : '已取消管理員'}
              </p>
              <h2 className="text-lg font-extrabold text-foreground">{d.receipt.name}</h2>
              <p className="text-sm text-muted-foreground">
                {d.receipt.granted
                  ? '他下一個動作起就能管理帳號、名單、屆別與各項設定（包括停用與發臨時密碼）。'
                  : '他下一個動作起就沒有管理員權限了；其他角色不變。'}
                理由、操作者與時間已寫入紀錄。
              </p>
              <button type="button" onClick={d.close} className={cn(BUTTON, SECONDARY)}>
                關閉
              </button>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div>
                <h2 className="text-lg font-extrabold text-foreground">
                  {verb}：{account.name}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {granting
                    ? '管理員可以管理所有帳號與資料，包括停用別人、發臨時密碼。只給系辦與負責的老師。'
                    : '取消後他仍保有其他角色（例如老師）。系統至少要留一位管理員，也不能取消自己。'}
                </p>
              </div>
              <AccountFacts account={account} />
              <ReasonField
                value={d.reason}
                onChange={d.setReason}
                placeholder={granting ? '例：新任系辦承辦人' : '例：職務調整'}
                invalid={Boolean(d.error)}
              />
              <ErrorNote error={d.error} />
              <div className="flex justify-end gap-2">
                <button type="button" onClick={d.close} className={cn(BUTTON, SECONDARY)} disabled={d.busy}>
                  取消
                </button>
                <button type="submit" className={cn(BUTTON, granting ? PRIMARY : DANGER)} disabled={d.busy}>
                  {d.busy ? '處理中…' : `確認${verb}`}
                </button>
              </div>
            </form>
          )}
        </div>
      </dialog>
    </>
  )
}

// ── 孤兒帳號補建角色 ────────────────────────────────────────────────────────

const ORPHAN_CHOICES: readonly { role: OrphanRole; label: string; hint: string }[] = [
  { role: 'teacher', label: '老師', hint: '開通並給老師角色；本人下次登入先補姓名與聯絡資料。' },
  { role: 'admin', label: '職員（管理員）', hint: '開通並給管理員角色，例如系辦新同事。' },
]

export function OrphanRepairDialog({ account }: { account: RoleTargetView }) {
  const d = useDialog<OrphanRepairReceipt>()
  const [role, setRole] = useState<OrphanRole | ''>('')

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!role) {
      d.setError('請選擇要補建的角色。')
      return
    }
    if (!d.reason.trim()) {
      d.setError('請寫理由。')
      return
    }
    await d.run(
      () => repairOrphanAction({ userId: account.userId, role, reason: d.reason, requestId: d.requestId }),
      '結果未知：可能已經補建。請再按一次確認（不會重複做），或關閉後重新整理。',
    )
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setRole('')
          d.open()
        }}
        className={cn(BUTTON, SECONDARY, 'h-7 px-2.5 text-[0.8rem] font-medium')}
        aria-label={`補建角色 ${account.name}`}
      >
        補建角色
      </button>
      <dialog ref={d.ref} onClose={d.onClosed} aria-label={`補建角色 ${account.name}`} className={DIALOG}>
        <div className="p-5">
          {!d.isOpen ? null : d.receipt ? (
            <div className="space-y-3 text-center" role="status">
              <p className="inline-block rounded-full bg-primary-subtle px-3 py-1 text-sm font-medium text-primary-on-subtle">
                已補建為{d.receipt.role === 'teacher' ? '老師' : '管理員'}
              </p>
              <h2 className="text-lg font-extrabold text-foreground">{d.receipt.name}</h2>
              <p className="text-sm text-muted-foreground">
                {d.receipt.activated ? '帳號已開通。' : ''}
                如果本人登不進來（系辦直接新增時出錯留下的帳號沒有人知道密碼），請接著按這一列的「發臨時密碼」；
                用 Google 的人直接用 Google 登入即可。理由、操作者與時間已寫入紀錄。
              </p>
              <button type="button" onClick={d.close} className={cn(BUTTON, SECONDARY)}>
                關閉
              </button>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div>
                <h2 className="text-lg font-extrabold text-foreground">補建角色：{account.name}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  這個帳號只有登入身分：沒有角色、沒有註冊申請、沒有個人資料。通常是新增老師時系統出錯留下的，
                  也可能是註冊了還沒送出申請的學生——學生請讓本人登入補送申請，不要在這裡補。
                </p>
              </div>
              <AccountFacts account={account} />
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium text-foreground">補成</legend>
                {ORPHAN_CHOICES.map((choice) => (
                  <label key={choice.role} className="flex cursor-pointer items-start gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                    <input
                      type="radio"
                      name={`orphan-role-${account.userId}`}
                      value={choice.role}
                      checked={role === choice.role}
                      onChange={() => {
                        setRole(choice.role)
                        d.setError(null)
                      }}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="font-medium text-foreground">{choice.label}</span>
                      <span className="block text-xs text-muted-foreground">{choice.hint}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <ReasonField value={d.reason} onChange={d.setReason} placeholder="例：新增老師時系統出錯，補建" invalid={Boolean(d.error)} />
              <ErrorNote error={d.error} />
              <div className="flex justify-end gap-2">
                <button type="button" onClick={d.close} className={cn(BUTTON, SECONDARY)} disabled={d.busy}>
                  取消
                </button>
                <button type="submit" className={cn(BUTTON, PRIMARY)} disabled={d.busy}>
                  {d.busy ? '處理中…' : '確認補建'}
                </button>
              </div>
            </form>
          )}
        </div>
      </dialog>
    </>
  )
}
