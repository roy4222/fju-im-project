'use client'
import { createContext, useContext, useRef, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import type { BulkApprovalPreview, BulkApprovalReceipt, RosterMatchStatus, VerificationMethod } from '@/application/accounts'
import { cn } from '@/shared/cn'
import { bulkApproveAction, previewBulkApproveAction } from './actions'
import type { ReviewLabels } from './review-dialog'

/**
 * 批次核准註冊（第三波 W6，N-09；§9 第 3 條「篩選 → 多選 → 批次」）。
 *
 * 待審清單每列一個勾選框；勾了才出現「核准勾選的 N 位」。對話框照批次停用的「預覽 → 確認」：
 * 伺服器先列出每一位的姓名、學號、名單比對結果，需要人判斷的（名單比對不到、學號已被使用……）
 * 自動排除並寫原因；整批共用一個「怎麼確認是本人」與說明。確認後伺服器以當下的待審清單再分類一次，
 * 每一位各自走一次單筆核准（各自成功或失敗），結果寫「成功 N、略過 M」。
 *
 * 這裡**不判任何規則**：略過與否、確認本人的欄位對不對都由伺服器決定，錯誤訊息照伺服器的顯示。
 */

const BUTTON =
  // 外觀照原型（票 36）：h-10、圓角、粗一點的字；主要動作系網橘、次要白底細框。
  'press inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4'
const PRIMARY = 'btn-fju rounded-[4px]'
const SECONDARY = 'border border-border bg-background text-foreground hover:bg-muted'
const TEXTAREA =
  'mt-1.5 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-normal outline-none transition-[border-color,box-shadow] focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25'

const MATCH_LABEL: Record<RosterMatchStatus, string> = {
  matched: '名單符合',
  name_mismatch: '姓名不符',
  not_found: '不在本屆名單上',
}

// ── 勾選狀態 ─────────────────────────────────────────────────────────────────

type Selection = {
  readonly selected: ReadonlySet<string>
  readonly toggle: (id: string, on: boolean) => void
  readonly setAll: (ids: readonly string[], on: boolean) => void
  readonly clear: () => void
}

const SelectionContext = createContext<Selection | null>(null)

function useSelection(): Selection {
  const value = useContext(SelectionContext)
  if (!value) throw new Error('BulkApprove* 要放在 BulkApproveProvider 裡')
  return value
}

/** 包住待審核整塊：勾選框、全選與「核准勾選的 N 位」共用同一份勾選。 */
export function BulkApproveProvider({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const value: Selection = {
    selected,
    toggle: (id, on) =>
      setSelected((prev) => {
        const next = new Set(prev)
        if (on) next.add(id)
        else next.delete(id)
        return next
      }),
    setAll: (ids, on) => setSelected(on ? new Set(ids) : new Set()),
    clear: () => setSelected(new Set()),
  }
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>
}

export function BulkApproveCheckbox({ applicationId, name }: { applicationId: string; name: string }) {
  const { selected, toggle } = useSelection()
  return (
    <input
      type="checkbox"
      className="size-4 align-middle accent-brand"
      aria-label={`勾選待審 ${name}`}
      checked={selected.has(applicationId)}
      onChange={(e) => toggle(applicationId, e.target.checked)}
    />
  )
}

export function BulkApproveSelectAll({ applicationIds }: { applicationIds: readonly string[] }) {
  const { selected, setAll } = useSelection()
  const count = applicationIds.filter((id) => selected.has(id)).length
  const all = count > 0 && count === applicationIds.length
  return (
    <input
      type="checkbox"
      className="size-4 align-middle accent-brand"
      aria-label="全選待審"
      checked={all}
      ref={(el) => {
        if (el) el.indeterminate = count > 0 && !all
      }}
      onChange={(e) => setAll(applicationIds, e.target.checked)}
    />
  )
}

// ── 對話框 ───────────────────────────────────────────────────────────────────

type Item = { applicationId: string; revision: number; requestId: string }

type Phase =
  | { kind: 'loading' }
  | { kind: 'preview'; preview: BulkApprovalPreview; items: Item[]; previewSkipped: string[] }
  | { kind: 'done'; receipt: BulkApprovalReceipt }

/** 「核准勾選的 N 位」按鈕與對話框。沒勾任何人時不出現（不留點了沒反應的入口）。 */
export function BulkApproveDialog({ labels }: { labels: ReviewLabels }) {
  const router = useRouter()
  const { selected, clear } = useSelection()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [isOpen, setIsOpen] = useState(false)
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [method, setMethod] = useState<VerificationMethod | null>(null)
  const [note, setNote] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function open() {
    setPhase({ kind: 'loading' })
    setMethod(null)
    setNote('')
    setReason('')
    setError(null)
    setIsOpen(true)
    dialogRef.current?.showModal()
    try {
      const result = await previewBulkApproveAction({ applicationIds: [...selected] })
      if (!result.ok) {
        setError(result.message)
        return
      }
      // 要核准的人在預覽當下就固定（之後只會縮小、不會擴大）：確認前名單補齊了，預覽略過的人也不會被核准。
      // 每一位一個請求編號，整個對話框期間不變：結果未知再按一次時，已核准的會回放、不重複核准。
      const items = result.data.rows
        .filter((r) => !r.skip)
        .map((r) => ({ applicationId: r.applicationId, revision: r.revision, requestId: crypto.randomUUID() }))
      // 預覽略過的另外送：伺服器只回報原因，結果的「略過」才會列出他們。
      const previewSkipped = result.data.rows.filter((r) => r.skip).map((r) => r.applicationId)
      setPhase({ kind: 'preview', preview: result.data, items, previewSkipped })
    } catch {
      setError('預覽失敗，請關閉後再試一次。')
    }
  }

  function onClosed() {
    setIsOpen(false)
    if (phase.kind === 'done') {
      clear()
      router.refresh()
    }
  }

  async function confirm(items: Item[], previewSkipped: string[]) {
    if (!method) {
      setError('請選擇怎麼確認是本人。')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await bulkApproveAction({ items, previewSkipped, verificationMethod: method, verificationNote: note, reason })
      if (result.ok) setPhase({ kind: 'done', receipt: result.data })
      else setError(result.message)
    } catch {
      setError('結果未知：可能已經核准了一部分。請再按一次確認（不會重複核准），或關閉後重新整理。')
    } finally {
      setBusy(false)
    }
  }

  if (selected.size === 0 && !isOpen) return null

  return (
    <>
      {selected.size > 0 ? (
        <button type="button" onClick={open} className={cn(BUTTON, PRIMARY, 'h-8 px-3 text-[0.8rem]')}>
          核准勾選的 {selected.size} 位
        </button>
      ) : null}
      <dialog
        ref={dialogRef}
        onClose={onClosed}
        aria-label="批次核准"
        className="m-auto w-[min(40rem,calc(100vw-2rem))] rounded-xl border-0 bg-popover p-0 ring-1 ring-foreground/10 backdrop:bg-black/10 backdrop:backdrop-blur-xs"
      >
        <div className="max-h-[85vh] overflow-y-auto p-5">
          {!isOpen ? null : phase.kind === 'done' ? (
            <DoneStep receipt={phase.receipt} onClose={() => dialogRef.current?.close()} />
          ) : phase.kind === 'loading' ? (
            <div className="space-y-4">
              <h2 className="text-lg font-extrabold text-foreground">批次核准</h2>
              {error ? (
                <p role="alert" className="rounded-lg bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
                  {error}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">正在比對勾選的 {selected.size} 位…</p>
              )}
              <div className="flex justify-end">
                <button type="button" onClick={() => dialogRef.current?.close()} className={cn(BUTTON, SECONDARY)}>
                  關閉
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-extrabold text-foreground">批次核准預覽</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  只核准「會核准」那幾位，每一位各自開通、各自寫入紀錄；會略過的人不動，請之後個別打開審核。
                </p>
              </div>

              <ul className="max-h-60 overflow-y-auto rounded-lg border border-border text-sm" aria-label="勾選的人">
                {phase.preview.rows.map((r) => (
                  <li
                    key={r.applicationId}
                    data-testid="bulk-approve-row"
                    className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border px-3 py-2 last:border-0"
                  >
                    <span className="min-w-0">
                      <span className="font-semibold text-foreground">{r.appliedName}</span>
                      <span className="ml-2 tabular-nums text-muted-foreground">{r.studentNo}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{MATCH_LABEL[r.rosterMatch]}</span>
                    </span>
                    {r.skip ? (
                      <span className="text-xs text-brand-on-subtle">略過：{r.skipLabel}</span>
                    ) : (
                      <span className="text-xs text-foreground">會核准，進 {r.cohortName}</span>
                    )}
                  </li>
                ))}
              </ul>
              {phase.preview.missing > 0 ? (
                <p className="text-xs text-muted-foreground">
                  另有 {phase.preview.missing} 位已經不在待審清單（可能剛被處理過），不會再處理。
                </p>
              ) : null}

              {phase.items.length === 0 ? (
                <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
                  勾選的人都需要個別審核，沒有可以一起核准的。請關閉後逐一打開「審核」。
                </p>
              ) : (
                <>
                  <fieldset className="space-y-2">
                    <legend className="text-sm font-medium text-foreground">
                      怎麼確認是本人 <span className="font-normal text-muted-foreground">・必選，這一批共用</span>
                    </legend>
                    {labels.methods.map((m) => (
                      <label key={m} className="flex items-start gap-2 text-sm text-foreground">
                        <input
                          type="radio"
                          name="bulk-approve-method"
                          value={m}
                          checked={method === m}
                          onChange={() => {
                            setMethod(m)
                            setError(null)
                          }}
                          className="mt-1"
                        />
                        {labels.methodLabel[m]}
                      </label>
                    ))}
                    {method ? (
                      <label className="block text-sm font-medium text-foreground">
                        怎麼確認的說明
                        <span className="ml-1 font-normal text-muted-foreground">・{labels.noteHint[method]}</span>
                        <textarea
                          rows={2}
                          value={note}
                          onChange={(e) => {
                            setNote(e.target.value)
                            setError(null)
                          }}
                          required={labels.noteRequired[method]}
                          className={TEXTAREA}
                        />
                      </label>
                    ) : null}
                  </fieldset>
                  <label className="block text-sm font-medium text-foreground">
                    理由 <span className="font-normal text-muted-foreground">・選填，會寫入每一位的紀錄</span>
                    <textarea
                      rows={2}
                      value={reason}
                      onChange={(e) => {
                        setReason(e.target.value)
                        setError(null)
                      }}
                      className={TEXTAREA}
                    />
                  </label>
                </>
              )}

              {error ? (
                <p role="alert" className="rounded-lg bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
                  {error}
                </p>
              ) : null}

              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => dialogRef.current?.close()} className={cn(BUTTON, SECONDARY)} disabled={busy}>
                  取消
                </button>
                {phase.items.length > 0 ? (
                  <button type="button" onClick={() => confirm(phase.items, phase.previewSkipped)} className={cn(BUTTON, PRIMARY)} disabled={busy}>
                    {busy ? '核准中…' : `核准 ${phase.items.length} 位`}
                  </button>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </dialog>
    </>
  )
}

function DoneStep({ receipt, onClose }: { receipt: BulkApprovalReceipt; onClose: () => void }) {
  return (
    <div className="space-y-3" role="status">
      <h2 className="text-center text-lg font-extrabold text-foreground">
        成功 {receipt.approved.length}、略過 {receipt.skipped.length}
      </h2>
      <p className="text-center text-sm text-muted-foreground">
        核准的人已開通，重新登入就會進學生首頁；確認本人的方式、操作者與時間已逐筆寫入操作紀錄。
      </p>
      {receipt.skipped.length > 0 ? (
        <section aria-label="略過的人">
          <h3 className="mb-1 text-sm font-medium text-foreground">略過的人（請個別審核）</h3>
          <ul className="max-h-40 overflow-y-auto rounded-lg border border-border text-xs">
            {receipt.skipped.map((s) => (
              <li key={s.applicationId} className="flex justify-between gap-3 border-b border-border px-3 py-1.5 last:border-0">
                <span className="text-foreground">{s.appliedName || '（已不在待審清單）'}</span>
                <span className="text-brand-on-subtle">{s.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <div className="flex justify-center">
        <button type="button" onClick={onClose} className={cn(BUTTON, SECONDARY)}>
          關閉
        </button>
      </div>
    </div>
  )
}
