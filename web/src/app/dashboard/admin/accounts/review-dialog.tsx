'use client'
import { useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { CohortChoice, DecisionReceipt, EvidenceFlag, PendingApplication } from '@/application/accounts'
import { cn } from '@/shared/cn'
import { approveRegistrationAction, rejectRegistrationAction } from './actions'

/**
 * 待審清單每列的兩顆鈕：核准、退回（C2-10；原型 `/dashboard/admin/accounts` 的 ApproveDialog）。
 *
 * - 核准：名單比對到、只有一屆、學號沒有爭議 → 一鍵完成，不開視窗，不問怎麼確認是本人（資料庫固定寫 `office_review`）。
 *   其他情況（名單沒有這個人、姓名不同、跨屆、學號有爭議）開小視窗：選屆別、看提醒，再核准。
 * - 退回：視窗只有一欄理由，必填，申請人會看到。
 *
 * 這裡**不判任何規則**：按鈕送出後由伺服器決定，錯誤訊息照伺服器的顯示。
 */

export type ReviewLabels = {
  readonly evidence: Record<EvidenceFlag, string>
  readonly attention: Record<EvidenceFlag, boolean>
}

const BUTTON =
  // 外觀照原型（票 36）：h-10、圓角、粗一點的字；主要動作系網橘、次要白底細框、危險淡紅。
  'press inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4'
const PRIMARY = 'btn-fju rounded-[4px]'
const SECONDARY = 'border border-border bg-background text-foreground hover:bg-muted'
const TEXTAREA =
  'mt-1.5 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-normal outline-none transition-[border-color,box-shadow] focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25'

export function EvidencePills({ flags, labels }: { flags: readonly EvidenceFlag[]; labels: ReviewLabels }) {
  return (
    <span className="flex flex-wrap gap-1">
      {flags.map((flag) => (
        <span
          key={flag}
          data-flag={flag}
          className={cn(
            'inline-flex h-5 items-center rounded-4xl border px-2 text-[11px] font-medium whitespace-nowrap',
            labels.attention[flag] ? 'border-brand/30 bg-brand-subtle text-brand-on-subtle' : 'border-border bg-muted text-muted-foreground',
          )}
        >
          {labels.evidence[flag]}
        </span>
      ))}
    </span>
  )
}

type Phase =
  | { kind: 'form' }
  | { kind: 'done'; receipt: DecisionReceipt }
  | { kind: 'stale'; message: string }

type Mode = 'approve' | 'reject'

export function ReviewDialog({
  application: a,
  cohorts,
  registrationOpenCohort,
  labels,
}: {
  application: PendingApplication
  cohorts: readonly CohortChoice[]
  registrationOpenCohort: CohortChoice | null
  labels: ReviewLabels
}) {
  const router = useRouter()
  const dialogRef = useRef<HTMLDialogElement>(null)
  // 關著的時候不渲染內容：待審清單每一列都有對話框，全部先畫出來會讓整頁變很重。
  const [isOpen, setIsOpen] = useState(false)
  const [mode, setMode] = useState<Mode>('approve')
  const [phase, setPhase] = useState<Phase>({ kind: 'form' })
  const [reason, setReason] = useState('')
  const [cohortId, setCohortId] = useState<string>(a.suggestedCohortId ?? '')
  const [error, setError] = useState<{ message: string; field?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  // 一次按下去＝一次審核請求；同一個編號重送只會生效一次（帳本），斷線重試是安全的。
  const [requestId, setRequestId] = useState('')

  const match = a.match
  const hit = match.hit
  const hitCohortIds = new Set(match.hits.map((h) => h.cohortId))
  const cohortOptions = hitCohortIds.size > 1 ? onlyCohorts(cohorts, hitCohortIds) : cohorts
  const lockedCohort = a.cohortLocked ? cohorts.find((c) => c.id === hit?.cohortId) ?? null : null
  const hasDispute = a.duplicates.activeHolders.length > 0 || a.duplicates.otherPending > 0 || hitCohortIds.size > 1
  // 名單比對到（姓名也相符）、屆別由名單決定、學號沒有爭議：不需要系辦再判斷什麼，一鍵核准。
  const oneClick = match.status === 'matched' && a.cohortLocked && !hasDispute

  function openDialog(next: Mode) {
    setMode(next)
    setPhase({ kind: 'form' })
    setReason('')
    setCohortId(a.suggestedCohortId ?? '')
    setError(null)
    setRequestId(crypto.randomUUID())
    setIsOpen(true)
    dialogRef.current?.showModal()
  }

  function close() {
    dialogRef.current?.close()
  }

  /**
   * 對話框關掉（按鈕或 Esc）之後才刷新清單。
   * 不在結果出來就刷新：一刷新，這一列就從待審清單消失，對話框跟著卸載，系辦還沒看到回執就沒了。
   */
  function onClosed() {
    setIsOpen(false)
    if (phase.kind !== 'form') router.refresh()
  }

  function onServerError(result: { code: string; message: string; field?: string }) {
    if (result.code === 'CONFLICT') setPhase({ kind: 'stale', message: result.message })
    else setError({ message: result.message, field: result.field })
  }

  async function sendApprove(withCohort: string | null) {
    return approveRegistrationAction({
      applicationId: a.applicationId,
      revision: a.revision,
      reason: '',
      cohortId: a.cohortLocked ? null : withCohort,
      requestId,
    })
  }

  /** 核准鈕：一鍵的直接送；其餘開小視窗。 */
  async function onApproveClick() {
    if (!oneClick) {
      openDialog('approve')
      return
    }
    const id = crypto.randomUUID()
    setRequestId(id)
    setBusy(true)
    try {
      const result = await approveRegistrationAction({
        applicationId: a.applicationId,
        revision: a.revision,
        reason: '',
        cohortId: null,
        requestId: id,
      })
      if (result.ok) {
        router.refresh()
        return
      }
      // 沒成功：開視窗把伺服器的話原樣顯示。
      openDialog('approve')
      onServerError(result)
    } catch {
      openDialog('approve')
      setError({ message: '結果未知：可能已經核准。請關閉後重新整理清單確認。' })
    } finally {
      setBusy(false)
    }
  }

  async function approveFromDialog() {
    setBusy(true)
    setError(null)
    try {
      const result = await sendApprove(cohortId || null)
      if (result.ok) setPhase({ kind: 'done', receipt: result.data })
      else onServerError(result)
    } catch {
      setError({ message: '結果未知：可能已經核准。請再按一次「核准」確認（不會重複核准），或關閉後重新整理。' })
    } finally {
      setBusy(false)
    }
  }

  async function reject() {
    if (!reason.trim()) {
      setError({ message: '退回一定要寫理由，申請人會看到這段。', field: 'reason' })
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await rejectRegistrationAction({
        applicationId: a.applicationId,
        revision: a.revision,
        reason,
        requestId,
      })
      if (result.ok) setPhase({ kind: 'done', receipt: result.data })
      else onServerError(result)
    } catch {
      setError({ message: '結果未知：可能已經退回。請再按一次「退回」確認，或關閉後重新整理。' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <button
          type="button"
          onClick={onApproveClick}
          disabled={busy}
          className={cn(BUTTON, 'h-7 rounded-lg bg-ink px-2.5 text-[0.8rem] font-medium text-ink-foreground hover:bg-ink/85')}
          aria-label={`核准 ${a.appliedName}`}
        >
          核准
        </button>
        <button
          type="button"
          onClick={() => openDialog('reject')}
          className={cn(BUTTON, SECONDARY, 'h-7 rounded-lg px-2.5 text-[0.8rem] font-medium')}
          aria-label={`退回 ${a.appliedName}`}
        >
          退回
        </button>
      </div>

      <dialog
        ref={dialogRef}
        onClose={onClosed}
        // 名稱固定：對話框從表單換成回執時，輔助科技（與測試）找的仍是同一個對話框。
        aria-label={`${mode === 'approve' ? '核准' : '退回'} ${a.appliedName}`}
        className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl border-0 bg-popover p-0 ring-1 ring-foreground/10 backdrop:bg-black/10 backdrop:backdrop-blur-xs"
      >
        <div className="max-h-[85vh] overflow-y-auto p-5">
          {!isOpen ? null : phase.kind === 'done' ? (
            <div className="space-y-3 text-center" role="status">
              <p className="inline-block rounded-full bg-primary-subtle px-3 py-1 text-sm font-medium text-primary-on-subtle">
                {phase.receipt.decision === 'approved' ? '已核准' : '已退回'}
              </p>
              <h2 className="text-lg font-extrabold text-foreground">{phase.receipt.appliedName}</h2>
              <p className="text-sm text-muted-foreground">
                {phase.receipt.decision === 'approved'
                  ? `已開通，進入 ${phase.receipt.cohortName}；比對依據、操作者與時間都已寫入紀錄。本人重新登入就會進學生首頁。`
                  : '退回理由、操作者與時間已寫入紀錄；申請人登入後會在等待審核頁看到理由，可以修改後重新送出。'}
              </p>
              <button type="button" onClick={close} className={cn(BUTTON, SECONDARY)}>
                關閉
              </button>
            </div>
          ) : phase.kind === 'stale' ? (
            <div className="space-y-3">
              <h2 className="text-lg font-extrabold text-foreground">資料已經變了</h2>
              <p role="alert" className="rounded-lg bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
                {phase.message}
              </p>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={close} className={cn(BUTTON, PRIMARY)}>
                  重新載入清單
                </button>
              </div>
            </div>
          ) : mode === 'reject' ? (
            <div className="space-y-4">
              <h2 className="text-lg font-extrabold text-foreground">退回 {a.appliedName}</h2>
              <label className="block text-sm font-medium text-foreground">
                理由 <span className="font-normal text-muted-foreground">・必填，申請人會看到</span>
                <textarea
                  rows={3}
                  value={reason}
                  onChange={(e) => {
                    setReason(e.target.value)
                    setError(null)
                  }}
                  aria-invalid={error?.field === 'reason' || undefined}
                  placeholder="例：名單姓名有誤字，請確認後重新送出"
                  className={TEXTAREA}
                />
              </label>
              {error ? (
                <p role="alert" className="rounded-lg bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
                  {error.message}
                </p>
              ) : null}
              <div className="flex flex-wrap justify-end gap-2">
                <button type="button" onClick={close} className={cn(BUTTON, SECONDARY)} disabled={busy}>
                  取消
                </button>
                <button type="button" onClick={reject} className={cn(BUTTON, PRIMARY)} disabled={busy}>
                  {busy ? '處理中…' : '退回'}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-extrabold text-foreground">核准 {a.appliedName}</h2>
                <div className="mt-2">
                  <EvidencePills flags={a.flags} labels={labels} />
                </div>
              </div>

              {hasDispute ? (
                <ul className="space-y-1 rounded-lg bg-primary-subtle px-3 py-2 text-sm text-primary-on-subtle" aria-label="需要特別核對">
                  {a.duplicates.activeHolders.map((h) => (
                    <li key={`${h.name}-${h.cohortCode}`}>
                      這個學號已經有一個有效帳號：{h.name}（{h.cohortCode}）。
                    </li>
                  ))}
                  {a.duplicates.otherPending > 0 ? (
                    <li>另外還有 {a.duplicates.otherPending} 筆待審申請填了同一個學號。</li>
                  ) : null}
                  {hitCohortIds.size > 1 ? (
                    <li>這個學號出現在 {hitCohortIds.size} 屆的名單上：{match.hits.map((h) => h.cohortName).join('、')}。</li>
                  ) : null}
                </ul>
              ) : null}

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium text-foreground">屆別</legend>
                {lockedCohort ? (
                  <p className="text-sm text-foreground" data-testid="locked-cohort">
                    {lockedCohort.name}（{lockedCohort.code}）<span className="ml-2 text-xs text-muted-foreground">依名單，不能改</span>
                  </p>
                ) : (
                  <>
                    {!registrationOpenCohort && hitCohortIds.size === 0 ? (
                      <p role="note" className="rounded-lg bg-primary-subtle px-3 py-2 text-sm text-primary-on-subtle">
                        目前沒有設定「新註冊學生加入的屆別」，所以不預選。請手動選一屆，或先到
                        <Link href="/dashboard/admin/cohorts" className="mx-1 underline">
                          屆別
                        </Link>
                        頁設定新註冊學生加入的屆別。
                      </p>
                    ) : null}
                    <label className="block text-sm">
                      <span className="sr-only">核准進哪一屆</span>
                      <select
                        aria-label="核准進哪一屆"
                        value={cohortId}
                        onChange={(e) => setCohortId(e.target.value)}
                        aria-invalid={error?.field === 'cohortId' || undefined}
                        className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none transition-[border-color,box-shadow] focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25"
                      >
                        <option value="">請選擇屆別</option>
                        {cohortOptions.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}（{c.code}）{registrationOpenCohort?.id === c.id ? '・新註冊加入這屆' : ''}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                )}
              </fieldset>

              {error ? (
                <p role="alert" className="rounded-lg bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
                  {error.message}
                </p>
              ) : null}

              <div className="flex flex-wrap justify-end gap-2">
                <button type="button" onClick={close} className={cn(BUTTON, SECONDARY)} disabled={busy}>
                  取消
                </button>
                <button type="button" onClick={approveFromDialog} className={cn(BUTTON, PRIMARY)} disabled={busy}>
                  {busy ? '處理中…' : '核准'}
                </button>
              </div>
            </div>
          )}
        </div>
      </dialog>
    </>
  )
}

/** 跨屆命中時，屆別只能在命中的那幾屆裡選。 */
function onlyCohorts(cohorts: readonly CohortChoice[], ids: ReadonlySet<string>): CohortChoice[] {
  return cohorts.filter((c) => ids.has(c.id))
}
