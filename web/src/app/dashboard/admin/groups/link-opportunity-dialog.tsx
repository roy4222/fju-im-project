'use client'
import { startTransition, useActionState, useEffect, useRef, useState, type FormEvent } from 'react'
import { linkOpportunityAction, searchLinkOptionsAction, unlinkGroupOpportunityAction } from './actions'
import { DIALOG, Feedback, INPUT, LABEL, PRIMARY, SECONDARY, useCloseOnSuccess, useDialog } from './admin-group-forms'
import { ALERT, BTN_ROW_GHOST as ROW_GHOST } from '@/app/_ui/dashboard/look'
import type { LinkOption } from '@/application/groups'

/**
 * 「把組別連到合作案」對話框（AD-06，設計方案 §3.3.1；Q73）。放在產學組卡片與詳情，一般組不渲染。
 *
 * 選項：頁面先傳前 50 筆已發布合作案（`linkOptions`）；搜尋框常駐，打字或按「上一頁／下一頁」
 * 都改走 `searchLinkOptionsAction`（系辦守衛在 action）。回傳沒有總數，所以「下一頁」只在這次剛好 50 筆時出現；
 * 查詢改變時回到第一頁。
 * 首次連結與換案的理由皆可留空，失敗訊息照後端原字。
 */

export type LinkOptionsOutcome =
  | { ok: true; options: readonly LinkOption[] }
  | { ok: false; code: 'FORBIDDEN'; message: string }

const PAGE = 50
const SEARCH_DELAY_MS = 250

export function UnlinkOpportunityButton({ linkId, code, requestId, reasonMaxLength }: {
  linkId: string | null; code: string; requestId: string; reasonMaxLength: number
}) {
  const [state, action, pending] = useActionState(unlinkGroupOpportunityAction, undefined)
  const dialog = useDialog()
  useCloseOnSuccess(state, dialog.close)
  if (!linkId) return <Feedback state={state?.ok ? state : undefined} />
  return <div>
    <button type="button" className={`${ROW_GHOST} pointer-coarse:min-h-11 pointer-coarse:min-w-11`} onClick={dialog.open}>解除合作案</button>
    <Feedback state={state?.ok ? state : undefined} />
    <dialog ref={dialog.ref} className={DIALOG} aria-label={`解除 ${code} 的合作案`}>
      <form key={linkId} action={action} className="space-y-4 p-5">
        <h2 className="text-lg font-bold">解除 {code} 的合作案</h2>
        <input type="hidden" name="linkId" value={linkId} />
        <input type="hidden" name="requestId" value={requestId} />
        <label htmlFor={`unlink-${linkId}`} className={LABEL}>理由（可不填）</label>
        <textarea id={`unlink-${linkId}`} name="reason" maxLength={reasonMaxLength} className={INPUT} />
        <Feedback state={state?.ok ? undefined : state} />
        <div className="flex justify-end gap-2">
          <button type="button" className={SECONDARY} onClick={dialog.close}>先不要</button>
          <button type="submit" className={PRIMARY} disabled={pending}>確定解除</button>
        </div>
      </form>
    </dialog>
  </div>
}

function optionLabel(o: LinkOption): string {
  return [o.companyName, o.department, o.ownerName].filter((s) => s.trim() !== '').join('・')
}

export function LinkOpportunityButton({
  group,
  current,
  initialOptions,
  requestId,
  reasonMaxLength,
}: {
  group: { id: string; code: string; revision: number }
  /** 目前連結的合作案名稱；沒有連結是 `null`。 */
  current: string | null
  initialOptions: readonly LinkOption[]
  requestId: string
  reasonMaxLength: number
}) {
  const [state, action, pending] = useActionState(linkOpportunityAction, undefined)
  const dialog = useDialog()
  useCloseOnSuccess(state, dialog.close)
  const switching = current !== null
  const title = switching ? `把 ${group.code} 改連到別的合作案` : `把 ${group.code} 連到合作案`

  const [q, setQ] = useState('')
  const [offset, setOffset] = useState(0)
  const [options, setOptions] = useState<readonly LinkOption[]>(initialOptions)
  const [selected, setSelected] = useState(initialOptions[0]?.id ?? '')
  const [loading, setLoading] = useState(false)
  /** 目前下拉是哪個查詢的結果（測試靠它等查詢回來）。 */
  const [appliedQ, setAppliedQ] = useState('')
  const [searchError, setSearchError] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [seenRevision, setSeenRevision] = useState(group.revision)
  // 連結成功後組別換版：理由清空，下一次打開是「改連結」（渲染中依 prop 調整 state）。
  if (seenRevision !== group.revision) {
    setSeenRevision(group.revision)
    setReason('')
  }
  // 只採用最後一次查詢的結果（打字很快時，早送出的查詢可能晚回來）。
  const latest = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const load = async (nextQ: string, nextOffset: number) => {
    const seq = ++latest.current
    setLoading(true)
    let result: LinkOptionsOutcome
    try {
      result = await searchLinkOptionsAction({ q: nextQ, offset: nextOffset })
    } catch {
      // 查詢中會鎖住下拉與「連結」：請求丟例外也要解鎖，不能一直停在「查詢中…」。
      if (seq !== latest.current) return
      setLoading(false)
      setSearchError('查詢合作案失敗，請再試一次。')
      return
    }
    if (seq !== latest.current) return
    setLoading(false)
    if (!result.ok) {
      setSearchError(result.message)
      return
    }
    setSearchError(null)
    setOffset(nextOffset)
    setAppliedQ(nextQ)
    setOptions(result.options)
    // 原本選的案還在新清單裡就保留，不悄悄換成第一筆（否則按「連結」會連到別的案）。
    const options = result.options
    setSelected((prev) => (options.some((o) => o.id === prev) ? prev : (options[0]?.id ?? '')))
  }

  const search = (value: string) => {
    setQ(value)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void load(value.trim(), 0), SEARCH_DELAY_MS)
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    startTransition(() => action(formData))
  }

  const ids = { search: `link-search-${group.id}`, pick: `link-pick-${group.id}`, reason: `link-reason-${group.id}` }

  return (
    <>
      <button
        type="button"
        className="press text-xs font-semibold whitespace-nowrap text-primary hover:underline"
        aria-label={switching ? `改連結 ${group.code}` : `連結合作案 ${group.code}`}
        onClick={dialog.open}
      >
        {switching ? '改連結' : '連結合作案'}
      </button>
      <Feedback state={state?.ok ? state : undefined} />
      <dialog ref={dialog.ref} aria-label={title} className={DIALOG}>
        <form key={group.revision} onSubmit={submit} className="space-y-4 p-5">
          <div>
            <h2 className="text-lg font-extrabold text-foreground">{title}</h2>
            {switching ? <p className="mt-1 text-sm text-foreground">目前連結：{current}</p> : null}
          </div>
          <input type="hidden" name="groupId" value={group.id} />
          <input type="hidden" name="revision" value={group.revision} />
          <input type="hidden" name="requestId" value={requestId} />
          <div>
            <label htmlFor={ids.search} className={LABEL}>
              搜尋公司名
            </label>
            <input
              id={ids.search}
              type="search"
              value={q}
              maxLength={100}
              onChange={(e) => search(e.target.value)}
              onKeyDown={(e) => {
                // 搜尋框裡按 Enter 是查詢，不是送出連結。
                if (e.key === 'Enter') {
                  e.preventDefault()
                  if (timer.current) clearTimeout(timer.current)
                  void load(q.trim(), 0)
                }
              }}
              placeholder="例：台積電"
              className={INPUT}
            />
          </div>
          <div data-testid="link-options" data-query={appliedQ} aria-busy={loading}>
            <label htmlFor={ids.pick} className={LABEL}>
              合作案
            </label>
            {options.length > 0 ? (
              <select
                id={ids.pick}
                name="opportunityId"
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                disabled={loading}
                className={INPUT}
              >
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {optionLabel(o)}
                  </option>
                ))}
              </select>
            ) : (
              <p id={ids.pick} className="mt-1.5 text-sm text-muted-foreground">
                {loading ? '查詢中…' : '找不到符合的合作案'}
              </p>
            )}
            {searchError ? (
              <p role="alert" className={`mt-1 ${ALERT}`}>
                {searchError}
              </p>
            ) : null}
            {offset > 0 || options.length === PAGE ? (
              <div className="mt-2 flex gap-2">
                {offset > 0 ? (
                  <button type="button" className={ROW_GHOST} disabled={loading} onClick={() => void load(q.trim(), Math.max(0, offset - PAGE))}>
                    上一頁
                  </button>
                ) : null}
                {options.length === PAGE ? (
                  <button type="button" className={ROW_GHOST} disabled={loading} onClick={() => void load(q.trim(), offset + PAGE)}>
                    下一頁
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
          <div>
            <label htmlFor={ids.reason} className={LABEL}>
              理由（可不填）
            </label>
            <p id={`${ids.reason}-hint`} className="text-xs text-muted-foreground">
              可留空
            </p>
            <textarea
              id={ids.reason}
              name="reason"
              rows={3}
              maxLength={reasonMaxLength}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-describedby={`${ids.reason}-hint`}
              placeholder={switching ? '例：業師更換' : ''}
              className={INPUT}
            />
          </div>
          <Feedback state={state?.ok ? undefined : state} />
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <button type="button" className={SECONDARY} onClick={dialog.close}>
              取消
            </button>
            <button type="submit" disabled={pending || loading || selected === ''} className={PRIMARY}>
              {pending ? '處理中…' : '連結'}
            </button>
          </div>
        </form>
      </dialog>
    </>
  )
}
