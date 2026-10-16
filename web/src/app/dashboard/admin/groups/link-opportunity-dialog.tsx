'use client'
import { startTransition, useActionState, useEffect, useRef, useState, type FormEvent } from 'react'
import { linkOpportunityAction, searchLinkOptionsAction } from './actions'
import { DIALOG, Feedback, INPUT, LABEL, PRIMARY, SECONDARY, useCloseOnSuccess, useDialog } from './admin-group-forms'
import { ALERT, BTN_ROW_GHOST as ROW_GHOST } from '@/app/_ui/dashboard/look'
import type { LinkOption } from '@/application/groups'

/**
 * 「把組別連到合作案」對話框（AD-06，設計方案 §3.3.1；Q73）。只放在產學組那一列，一般組不渲染。
 *
 * 選項：頁面先傳前 50 筆已發布合作案（`linkOptions`）；搜尋框常駐，打字或按「上一頁／下一頁」
 * 都改走 `searchLinkOptionsAction`（系辦守衛在 action）。回傳沒有總數，所以「下一頁」只在這次剛好 50 筆時出現；
 * 查詢改變時回到第一頁。
 * 理由沿用後端語意：首次連結選填、換案必填；對話框不自己擋，失敗訊息照後端原字。
 */

export type LinkOptionsOutcome =
  | { ok: true; options: readonly LinkOption[] }
  | { ok: false; code: 'FORBIDDEN'; message: string }

const PAGE = 50
const SEARCH_DELAY_MS = 250

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
    const result = await searchLinkOptionsAction({ q: nextQ, offset: nextOffset })
    if (seq !== latest.current) return
    setLoading(false)
    if (!result.ok) {
      setSearchError(result.message)
      return
    }
    setSearchError(null)
    setOffset(nextOffset)
    setOptions(result.options)
    setSelected(result.options[0]?.id ?? '')
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
      {/* 小字文字鈕：組別表在 1280 寬不能有橫向捲軸（AC-AD-23），一般大小的按鈕會把「合作案」欄撐寬。 */}
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
          <div>
            <label htmlFor={ids.pick} className={LABEL}>
              合作案
            </label>
            {options.length > 0 ? (
              <select
                id={ids.pick}
                name="opportunityId"
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                aria-busy={loading}
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
              理由
            </label>
            <p id={`${ids.reason}-hint`} className="text-xs text-muted-foreground">
              {switching ? '換案必填' : '可留空'}
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
            <button type="submit" disabled={pending || selected === ''} className={PRIMARY}>
              {pending ? '處理中…' : '連結'}
            </button>
          </div>
        </form>
      </dialog>
    </>
  )
}
