'use client'
import { useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type {
  CohortChoice,
  DecisionReceipt,
  EvidenceFlag,
  PendingApplication,
  VerificationMethod,
} from '@/application/accounts'
import { cn } from '@/shared/cn'
import { approveRegistrationAction, rejectRegistrationAction } from './actions'

/**
 * 註冊審核對話框（票 7；原型 `/dashboard/admin/accounts` 的 ApproveDialog）。
 *
 * 證據並列：申請填的 vs 名冊上的（姓名、學號、系級、Email），加上重複學號與跨屆的提示。
 * 核准必選核實方式；未命中要指定屆別（預設帶開放註冊屆別，沒有就提示、不猜）；退回必填理由。
 *
 * 這裡**不判任何規則**：按鈕送出後由伺服器決定，錯誤訊息照伺服器的顯示。
 * 唯一的前端邏輯是「還沒選核實方式就不送」這種省一次來回的提示，伺服器照樣會再判。
 */

export type ReviewLabels = {
  readonly evidence: Record<EvidenceFlag, string>
  readonly attention: Record<EvidenceFlag, boolean>
  readonly methods: readonly VerificationMethod[]
  readonly methodLabel: Record<VerificationMethod, string>
  readonly noteRequired: Record<VerificationMethod, boolean>
  readonly noteHint: Record<VerificationMethod, string>
}

const BUTTON =
  'inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50'
const PRIMARY = 'bg-primary text-primary-foreground hover:bg-primary/90'
const SECONDARY = 'bg-muted text-foreground hover:bg-border'
const TEXTAREA = 'mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-normal'

export function EvidencePills({ flags, labels }: { flags: readonly EvidenceFlag[]; labels: ReviewLabels }) {
  return (
    <span className="flex flex-wrap gap-1">
      {flags.map((flag) => (
        <span
          key={flag}
          data-flag={flag}
          className={cn(
            'rounded-full px-2 py-0.5 text-xs whitespace-nowrap',
            labels.attention[flag] ? 'bg-primary-subtle text-primary-on-subtle' : 'bg-muted text-muted-foreground',
          )}
        >
          {labels.evidence[flag]}
        </span>
      ))}
    </span>
  )
}

function Compare({
  label,
  applied,
  roster,
  verdict,
}: {
  label: string
  applied: string
  roster: string | null
  verdict?: 'same' | 'different' | 'roster_blank' | 'not_applicable'
}) {
  const verdictText =
    verdict === 'same' ? '相同' : verdict === 'different' ? '不同' : verdict === 'roster_blank' ? '名單未填' : null
  return (
    <tr className="border-t border-border">
      <th scope="row" className="whitespace-nowrap py-2 pr-3 text-left font-normal text-muted-foreground">
        {label}
      </th>
      <td className="break-all py-2 pr-3 font-medium text-ink">{applied || '—'}</td>
      <td className={cn('break-all py-2 font-medium', verdict === 'different' ? 'text-danger-on-subtle' : 'text-ink')}>
        {roster ?? '—'}
        {verdictText ? <span className="ml-2 text-xs font-normal text-muted-foreground">{verdictText}</span> : null}
      </td>
    </tr>
  )
}

type Phase =
  | { kind: 'form' }
  | { kind: 'done'; receipt: DecisionReceipt }
  | { kind: 'stale'; message: string }

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
  // 關著的時候不渲染內容：待審清單每一列都有一個對話框，全部先畫出來會讓整頁變很重，
  // 而且隱藏的內容（屆別選單等）會混進那一列的文字裡。
  const [isOpen, setIsOpen] = useState(false)
  const [phase, setPhase] = useState<Phase>({ kind: 'form' })
  const [method, setMethod] = useState<VerificationMethod | ''>('')
  const [note, setNote] = useState('')
  const [reason, setReason] = useState('')
  const [cohortId, setCohortId] = useState<string>(a.suggestedCohortId ?? '')
  const [error, setError] = useState<{ message: string; field?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  // 一次打開對話框＝一次審核請求；同一個編號重送只會生效一次（帳本），斷線重試是安全的。
  const [requestId, setRequestId] = useState('')

  const match = a.match
  const hit = match.hit
  const hitCohortIds = new Set(match.hits.map((h) => h.cohortId))
  const cohortOptions = hitCohortIds.size > 1 ? onlyCohorts(cohorts, hitCohortIds) : cohorts
  const lockedCohort = a.cohortLocked ? cohorts.find((c) => c.id === hit?.cohortId) ?? null : null

  function open() {
    setPhase({ kind: 'form' })
    setMethod('')
    setNote('')
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
   * action 裡刻意不 revalidate：一刷新，這一列就從待審清單消失，對話框跟著卸載，
   * 系辦還沒看到回執就沒了。
   */
  function onClosed() {
    setIsOpen(false)
    if (phase.kind !== 'form') router.refresh()
  }

  function onServerError(result: { code: string; message: string; field?: string }) {
    if (result.code === 'CONFLICT') setPhase({ kind: 'stale', message: result.message })
    else setError({ message: result.message, field: result.field })
  }

  async function approve() {
    if (!method) {
      setError({ message: '請選擇核實方式。', field: 'verificationMethod' })
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await approveRegistrationAction({
        applicationId: a.applicationId,
        revision: a.revision,
        verificationMethod: method,
        verificationNote: note,
        reason,
        cohortId: a.cohortLocked ? null : cohortId || null,
        requestId,
      })
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
      <button type="button" onClick={open} className={cn(BUTTON, PRIMARY, 'whitespace-nowrap px-3 py-1.5')} aria-label={`審核 ${a.appliedName}`}>
        審核
      </button>

      <dialog
        ref={dialogRef}
        onClose={onClosed}
        // 名稱固定：對話框從表單換成回執時，輔助科技（與測試）找的仍是同一個對話框。
        aria-label={`審核 ${a.appliedName}`}
        className="m-auto w-[min(40rem,calc(100vw-2rem))] rounded-card border border-border bg-background p-0 backdrop:bg-ink/40"
      >
        <div className="max-h-[85vh] overflow-y-auto p-5">
          {!isOpen ? null : phase.kind === 'done' ? (
            <div className="space-y-3 text-center" role="status">
              <p className="inline-block rounded-full bg-primary-subtle px-3 py-1 text-sm font-medium text-primary-on-subtle">
                {phase.receipt.decision === 'approved' ? '已核准' : '已退回'}
              </p>
              <h2 className="text-lg font-semibold text-ink">
                {phase.receipt.appliedName}
              </h2>
              <p className="text-sm text-muted-foreground">
                {phase.receipt.decision === 'approved'
                  ? `已開通，進入 ${phase.receipt.cohortName}；核實方式「${labels.methodLabel[phase.receipt.verificationMethod!]}」、比對依據、操作者與時間都已寫入紀錄。本人重新登入就會進學生首頁。`
                  : '退回理由、操作者與時間已寫入紀錄；申請人登入後會在等待審核頁看到理由，可以修改後重新送出。'}
              </p>
              <button type="button" onClick={close} className={cn(BUTTON, SECONDARY)}>
                關閉
              </button>
            </div>
          ) : phase.kind === 'stale' ? (
            <div className="space-y-3">
              <h2 className="text-lg font-semibold text-ink">
                資料已經變了
              </h2>
              <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
                {phase.message}
              </p>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={close} className={cn(BUTTON, PRIMARY)}>
                  重新載入清單
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold text-ink">
                  審核 {a.appliedName}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  申請資料第 {a.revision} 版{a.revision > 1 ? '（學生修改過）' : ''}・登入 Email {a.loginEmail}
                </p>
                <div className="mt-2">
                  <EvidencePills flags={a.flags} labels={labels} />
                </div>
              </div>

              <table className="w-full text-sm" aria-label="申請資料與名冊並列">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="w-20 pb-1 font-normal" />
                    <th scope="col" className="pb-1 font-normal">
                      申請填寫
                    </th>
                    <th scope="col" className="pb-1 font-normal">
                      {hit ? `名冊（${hit.cohortName}）` : '名冊'}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <Compare
                    label="姓名"
                    applied={a.appliedName}
                    roster={hit ? hit.nameRaw : '未命中名單'}
                    verdict={hit ? (hit.nameMatches ? 'same' : 'different') : undefined}
                  />
                  <Compare label="學號" applied={a.studentNo} roster={hit ? a.studentNo : '—'} />
                  <Compare
                    label="系級"
                    applied={a.departmentClass}
                    roster={hit ? (hit.departmentClass ?? '') : null}
                    verdict={match.departmentClassComparison}
                  />
                  <Compare
                    label="Email"
                    applied={a.loginEmail}
                    roster={hit ? (hit.email ?? '') : null}
                    verdict={match.emailComparison}
                  />
                  <Compare label="手機" applied={a.phone} roster={null} />
                  <Compare label="聯絡 Email" applied={a.contactEmail} roster={null} />
                </tbody>
              </table>

              {a.duplicates.activeHolders.length > 0 || a.duplicates.otherPending > 0 || hitCohortIds.size > 1 ? (
                <ul className="space-y-1 rounded-md bg-primary-subtle px-3 py-2 text-sm text-primary-on-subtle" aria-label="需要特別核對">
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
                <legend className="text-sm font-medium text-ink">屆別</legend>
                {lockedCohort ? (
                  <p className="text-sm text-ink" data-testid="locked-cohort">
                    {lockedCohort.name}（{lockedCohort.code}）<span className="ml-2 text-xs text-muted-foreground">依名單，不能改</span>
                  </p>
                ) : (
                  <>
                    {!registrationOpenCohort && hitCohortIds.size === 0 ? (
                      <p role="note" className="rounded-md bg-primary-subtle px-3 py-2 text-sm text-primary-on-subtle">
                        目前沒有設定「開放註冊屆別」，所以不預選。請手動選一屆，或先到
                        <Link href="/dashboard/admin/cohorts" className="mx-1 underline">
                          屆別
                        </Link>
                        頁設定開放註冊屆別。
                      </p>
                    ) : null}
                    <label className="block text-sm">
                      <span className="sr-only">核准進哪一屆</span>
                      <select
                        aria-label="核准進哪一屆"
                        value={cohortId}
                        onChange={(e) => setCohortId(e.target.value)}
                        aria-invalid={error?.field === 'cohortId' || undefined}
                        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                      >
                        <option value="">請選擇屆別</option>
                        {cohortOptions.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}（{c.code}）{registrationOpenCohort?.id === c.id ? '・開放註冊' : ''}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                )}
              </fieldset>

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium text-ink">
                  核實方式 <span className="font-normal text-muted-foreground">・核准必選</span>
                </legend>
                {labels.methods.map((m) => (
                  <label key={m} className="flex items-start gap-2 text-sm text-ink">
                    <input
                      type="radio"
                      name={`method-${a.applicationId}`}
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
                  <label className="block text-sm font-medium text-ink">
                    核實說明
                    <span className="ml-1 font-normal text-muted-foreground">・{labels.noteHint[method]}</span>
                    <textarea
                      rows={2}
                      value={note}
                      onChange={(e) => {
                        setNote(e.target.value)
                        setError(null)
                      }}
                      aria-invalid={error?.field === 'verificationNote' || undefined}
                      required={labels.noteRequired[method]}
                      className={TEXTAREA}
                    />
                  </label>
                ) : null}
              </fieldset>

              <label className="block text-sm font-medium text-ink">
                理由 <span className="font-normal text-muted-foreground">・退回必填（申請人會看到），核准選填</span>
                <textarea
                  rows={2}
                  value={reason}
                  onChange={(e) => {
                    setReason(e.target.value)
                    setError(null)
                  }}
                  aria-invalid={error?.field === 'reason' || undefined}
                  placeholder="例：名單姓名有誤字，已向學生確認"
                  className={TEXTAREA}
                />
              </label>

              {error ? (
                <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
                  {error.message}
                </p>
              ) : null}

              <div className="flex flex-wrap justify-end gap-2">
                <button type="button" onClick={close} className={cn(BUTTON, SECONDARY)} disabled={busy}>
                  取消
                </button>
                <button type="button" onClick={reject} className={cn(BUTTON, SECONDARY)} disabled={busy}>
                  退回
                </button>
                <button type="button" onClick={approve} className={cn(BUTTON, PRIMARY)} disabled={busy}>
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
