'use client'
import { useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { IconPencil } from '@tabler/icons-react'
import type { MainRole, ProfileEditReceipt, ProfileEditView } from '@/application/accounts'
import { cn } from '@/shared/cn'
import { grantAdminAction, revokeAdminAction } from './actions'
import { editAccountAction, profileEditViewAction } from './edit-actions'

/**
 * 帳號列「編輯帳號」視窗（C 階段規格② §3.2 X10、§3.8 調屆、§3.9 學生↔老師互轉；票 C2-08）。
 *
 * 開視窗時向伺服器要一次「現在的樣子」：欄位、未封存的屆、不能改屆別／不能改角色的原因句。
 * 不能存時「儲存」disabled，按鈕 `title` 與下方小字同一句（A23）。規則都在伺服器再判一次，這裡只是先講。
 *
 * 角色＝「學生／老師」單選＋「管理員」勾。管理員勾沿用既有的設為／取消管理員（`actions.ts`），
 * 學生不能是管理員：選「學生」時管理員勾取消並鎖住；存的時候先取消管理員，再改角色。
 */

const BUTTON =
  'press inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4'
const PRIMARY = 'btn-fju rounded-[4px]'
const SECONDARY = 'border border-border bg-background text-foreground hover:bg-muted'
const ROW_BUTTON = 'h-7 border-transparent bg-transparent px-2.5 text-[0.8rem] font-medium hover:bg-muted'
const DIALOG =
  'm-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl border-0 bg-popover p-0 whitespace-normal ring-1 ring-foreground/10 backdrop:bg-black/10 backdrop:backdrop-blur-xs'
const INPUT =
  'mt-1.5 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-normal outline-none transition-[border-color,box-shadow] focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25 disabled:opacity-60'

/** 伺服器同一句（`STUDENT_FIELDS_REQUIRED`）；app 對 application 只能帶型別，這裡照抄字面。 */
const STUDENT_FIELDS_REQUIRED = '學生要有學號和屆別'
const ROLE_TEXT: Record<MainRole, string> = { student: '學生', teacher: '老師' }

type Draft = { name: string; role: MainRole | null; studentNo: string; cohortId: string; admin: boolean }

export function EditAccountDialog({ account }: { account: { readonly userId: string; readonly name: string } }) {
  const router = useRouter()
  const ref = useRef<HTMLDialogElement>(null)
  const [view, setView] = useState<ProfileEditView | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [receipt, setReceipt] = useState<ProfileEditReceipt | null>(null)
  const [changedAdmin, setChangedAdmin] = useState(false)
  const [requestIds, setRequestIds] = useState({ edit: '', admin: '' })

  async function open() {
    setView(null)
    setDraft(null)
    setError(null)
    setReceipt(null)
    setChangedAdmin(false)
    setRequestIds({ edit: crypto.randomUUID(), admin: crypto.randomUUID() })
    ref.current?.showModal()
    try {
      const result = await profileEditViewAction({ userId: account.userId })
      if (!result.ok) {
        setError(result.message)
        return
      }
      const v = result.data
      setView(v)
      setDraft({ name: v.name, role: v.role, studentNo: v.studentNo ?? '', cohortId: v.cohortId ?? '', admin: v.roles.includes('admin') })
    } catch {
      setError('讀不到這個帳號，請關閉後重新整理頁面。')
    }
  }

  function onClosed() {
    if (receipt || changedAdmin) router.refresh()
    setView(null)
    setDraft(null)
  }

  function patch(next: Partial<Draft>) {
    setDraft((d) => (d ? { ...d, ...next } : d))
    setError(null)
  }

  const blocked = view && draft ? saveBlocker(view, draft) : null

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!view || !draft || blocked) return
    setBusy(true)
    setError(null)
    try {
      const wasAdmin = view.roles.includes('admin')
      // 學生不能是管理員：要改成學生的管理員，先取消管理員再改角色。
      if (wasAdmin && !draft.admin && !changedAdmin) {
        const revoked = await revokeAdminAction({ userId: view.userId, reason: '', requestId: requestIds.admin })
        if (!revoked.ok) {
          setError(revoked.message)
          return
        }
        setChangedAdmin(true)
      }
      const profileChanged =
        draft.name.trim() !== view.name ||
        draft.role !== view.role ||
        (draft.role === 'student' && (draft.studentNo.trim() !== (view.studentNo ?? '') || draft.cohortId !== (view.cohortId ?? '')))
      let done: ProfileEditReceipt | null = null
      if (profileChanged) {
        const edited = await editAccountAction({
          userId: view.userId,
          name: draft.name,
          role: draft.role,
          studentNo: draft.role === 'student' ? draft.studentNo : '',
          cohortId: draft.role === 'student' ? draft.cohortId : '',
          requestId: requestIds.edit,
        })
        if (!edited.ok) {
          setError(edited.message)
          return
        }
        done = edited.data
      }
      if (!wasAdmin && draft.admin && !changedAdmin) {
        const granted = await grantAdminAction({ userId: view.userId, reason: '', requestId: requestIds.admin })
        if (!granted.ok) {
          setError(granted.message)
          return
        }
        setChangedAdmin(true)
      }
      setReceipt(
        done ?? { userId: view.userId, name: view.name, role: view.role, cohortCode: null, roleChanged: false, changedAt: new Date().toISOString() },
      )
    } catch {
      setError('結果未知：可能已經存好。請再按一次（不會重複做），或關閉後重新整理。')
    } finally {
      setBusy(false)
    }
  }

  const cohortOptions = view ? withCurrentCohort(view) : []

  return (
    <>
      <button type="button" onClick={open} className={cn(BUTTON, ROW_BUTTON)} aria-label={`編輯 ${account.name}`}>
        <IconPencil aria-hidden />
        編輯
      </button>
      <dialog ref={ref} onClose={onClosed} aria-label={`編輯帳號 ${account.name}`} className={DIALOG}>
        <div className="p-5">
          {receipt ? (
            <div className="space-y-3 text-center" role="status">
              <p className="inline-block rounded-full bg-primary-subtle px-3 py-1 text-sm font-medium text-primary-on-subtle">已儲存</p>
              <h2 className="text-lg font-extrabold text-foreground">{receipt.name}</h2>
              <p className="text-sm text-muted-foreground">
                {receipt.roleChanged && receipt.role
                  ? `他已改成${ROLE_TEXT[receipt.role]}，原本的登入已登出，重新登入後就是新身分。`
                  : '下一個動作起就照新的資料。'}
                操作者與時間已寫入紀錄。
              </p>
              <button type="button" onClick={() => ref.current?.close()} className={cn(BUTTON, SECONDARY)}>
                關閉
              </button>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <h2 className="text-lg font-extrabold text-foreground">編輯帳號：{account.name}</h2>
              {!view || !draft ? (
                error ? null : <p className="text-sm text-muted-foreground">讀取中…</p>
              ) : (
                <>
                  <p className="text-sm break-all text-muted-foreground">登入 Email：{view.loginEmail}</p>
                  <label className="block text-sm font-medium text-foreground">
                    姓名
                    <input value={draft.name} onChange={(e) => patch({ name: e.target.value })} className={INPUT} required />
                  </label>

                  {view.role ? (
                    <fieldset className="space-y-2">
                      <legend className="text-sm font-medium text-foreground">角色</legend>
                      <div className="flex flex-wrap gap-4 text-sm">
                        {(['student', 'teacher'] as const).map((role) => (
                          <label key={role} className="flex cursor-pointer items-center gap-2">
                            <input
                              type="radio"
                              name={`edit-role-${view.userId}`}
                              checked={draft.role === role}
                              onChange={() => patch(role === 'student' ? { role, admin: false } : { role, admin: view.roles.includes('admin') })}
                            />
                            {ROLE_TEXT[role]}
                          </label>
                        ))}
                        <label
                          className="flex cursor-pointer items-center gap-2"
                          title={draft.role === 'student' ? '學生帳號不能設為管理員' : undefined}
                        >
                          <input
                            type="checkbox"
                            checked={draft.admin}
                            disabled={draft.role === 'student'}
                            onChange={(e) => patch({ admin: e.target.checked })}
                          />
                          管理員
                        </label>
                      </div>
                    </fieldset>
                  ) : (
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={draft.admin} onChange={(e) => patch({ admin: e.target.checked })} />
                      管理員
                    </label>
                  )}

                  {/* 選「老師」後學號、屆別欄消失（§3.9）。 */}
                  {draft.role === 'student' ? (
                    <>
                      <label className="block text-sm font-medium text-foreground">
                        學號
                        <input value={draft.studentNo} onChange={(e) => patch({ studentNo: e.target.value })} className={cn(INPUT, 'tabular')} />
                      </label>
                      <div>
                        <label className="block text-sm font-medium text-foreground">
                          屆別
                          <select
                            value={draft.cohortId}
                            onChange={(e) => patch({ cohortId: e.target.value })}
                            disabled={Boolean(view.cohortLock) && view.role === 'student'}
                            className={INPUT}
                          >
                            <option value="">請選屆別</option>
                            {cohortOptions.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name && c.name !== c.code ? `${c.name}（${c.code}）` : c.code}
                              </option>
                            ))}
                          </select>
                        </label>
                        {view.cohortLock && view.role === 'student' ? (
                          <Link
                            href={`/dashboard/admin/groups/${view.cohortLock.groupId}`}
                            className="mt-1 block text-xs text-muted-foreground underline underline-offset-4 hover:text-primary"
                          >
                            {view.cohortLock.reason}
                          </Link>
                        ) : null}
                      </div>
                    </>
                  ) : null}
                </>
              )}

              {error ? (
                <p role="alert" className="rounded-lg bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
                  {error}
                </p>
              ) : null}
              <div className="flex flex-col items-end gap-1">
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => ref.current?.close()} className={cn(BUTTON, SECONDARY)} disabled={busy}>
                    取消
                  </button>
                  <button
                    type="submit"
                    className={cn(BUTTON, PRIMARY)}
                    disabled={busy || !view || Boolean(blocked)}
                    title={blocked ?? undefined}
                    aria-describedby={blocked ? `edit-blocked-${account.userId}` : undefined}
                  >
                    {busy ? '處理中…' : '儲存'}
                  </button>
                </div>
                {blocked ? (
                  <p id={`edit-blocked-${account.userId}`} className="text-xs text-muted-foreground" data-testid="edit-blocked">
                    {blocked}
                  </p>
                ) : null}
              </div>
            </form>
          )}
        </div>
      </dialog>
    </>
  )
}

/** 「儲存」旁那一句：角色互轉的前置條件，再來是學生必填。 */
function saveBlocker(view: ProfileEditView, draft: Draft): string | null {
  if (draft.role !== view.role) {
    const roleBlocked = draft.role === 'teacher' ? view.toTeacherBlocked : draft.role === 'student' ? view.toStudentBlocked : null
    if (roleBlocked) return roleBlocked
  }
  if (draft.role === 'student' && (!draft.studentNo.trim() || !draft.cohortId)) return STUDENT_FIELDS_REQUIRED
  return null
}

/** 目前的屆若已封存，下拉仍要看得到它（只是不能改過去別的封存屆）。 */
function withCurrentCohort(view: ProfileEditView): ProfileEditView['cohorts'] {
  if (!view.cohortId || view.cohorts.some((c) => c.id === view.cohortId)) return view.cohorts
  return [{ id: view.cohortId, code: '目前的屆', name: '目前的屆' }, ...view.cohorts]
}
