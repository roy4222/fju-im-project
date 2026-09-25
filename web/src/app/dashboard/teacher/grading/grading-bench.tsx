'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { saveGradingDraftAction, submitGradingAction } from './actions'
import type { FinalReceiptView } from '@/app/dashboard/teacher/grading/types'
import type { SchemeStage } from '@/application/grading'
import { cn } from '@/shared/cn'
import { formatScore, LETTER_GRADES, parseItemScore, teacherStageScore } from '@/shared/score'

/**
 * 評分工作台的評分表（票 23；原型 `GradingWorkbench` 右半邊）。
 *
 * - 分數即時驗證與預覽總分只在瀏覽器（和伺服器同一份算式 `@/shared/score`），**伺服器再驗一次**才算數。
 * - 「暫存」可以沒填完；只有本人與系辦看得到，不算正式分數。
 * - 「正式送出」要每一項都有效，先確認再送；送出後拿到收件章、欄位變唯讀。要改需系辦退回（票 24）。
 * - 同一次送出（連點、斷線重試）帶同一個請求編號，伺服器只算一次；內容一改就換新編號。
 */

const PRIMARY =
  'inline-flex h-11 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground ' +
  'hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50'
const SECONDARY =
  'inline-flex h-11 items-center justify-center gap-2 rounded-md border border-border bg-background px-4 text-sm font-medium ' +
  'text-ink hover:bg-muted disabled:opacity-50'

const newRequestId = () => crypto.randomUUID()

export function GradingBench({
  assignmentId,
  groupCode,
  stage,
  initialScores,
  locked,
  savedAtText,
  finalScore,
  submittedAtText,
  draftFromOlderVersion,
}: {
  assignmentId: string
  groupCode: string
  stage: SchemeStage
  initialScores: Readonly<Record<string, string>>
  locked: boolean
  savedAtText: string | null
  finalScore: string | null
  submittedAtText: string | null
  draftFromOlderVersion: boolean
}) {
  const router = useRouter()
  const [values, setValues] = useState<Record<string, string>>({ ...initialScores })
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<'save' | 'submit' | null>(null)
  const [savedText, setSavedText] = useState(savedAtText)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [serverBad, setServerBad] = useState<readonly string[]>([])
  const [receipt, setReceipt] = useState<FinalReceiptView | null>(null)
  const [isLocked, setLocked] = useState(locked)
  const requestIds = useRef({ save: newRequestId(), submit: newRequestId() })
  const confirmDialog = useRef<HTMLDialogElement>(null)
  const receiptDialog = useRef<HTMLDialogElement>(null)

  // 還有沒存的輸入時，離開頁面先問一聲。
  useEffect(() => {
    if (!dirty || isLocked) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, isLocked])

  const result = teacherStageScore(stage.items, stage.letterMap, values)
  const errors = new Map<string, string>()
  stage.items.forEach((item, index) => {
    const raw = values[item.key]
    if (!raw) return
    const parsed = parseItemScore(item, raw)
    if (!parsed.ok) {
      errors.set(item.key, item.type === 'number' ? `第 ${index + 1} 項要填 0–${item.max} 的數字（最多兩位小數）` : `第 ${index + 1} 項選項不對`)
    }
  })
  const missing = stage.items.filter((i) => !values[i.key]).length
  const complete = missing === 0 && errors.size === 0

  function set(key: string, value: string) {
    setValues((v) => ({ ...v, [key]: value }))
    setDirty(true)
    setServerBad((list) => list.filter((k) => k !== key))
    // 內容變了就是新的一次儲存／送出：換新的請求編號（舊編號配新內容會被當成 REQUEST_MISMATCH）。
    requestIds.current = { save: newRequestId(), submit: newRequestId() }
  }

  async function onSave() {
    if (errors.size > 0) {
      setMessage({ tone: 'error', text: `${[...errors.values()][0]}，修正後才能暫存。` })
      return
    }
    setBusy('save')
    setMessage(null)
    try {
      const outcome = await saveGradingDraftAction(assignmentId, values, requestIds.current.save)
      requestIds.current.save = newRequestId()
      if (!outcome.ok) {
        setMessage({ tone: 'error', text: outcome.message })
        setServerBad(outcome.fields ?? [])
        if (outcome.code === 'CONFLICT') router.refresh()
        return
      }
      setSavedText(outcome.data.savedAtText)
      setDirty(false)
      setMessage({ tone: 'ok', text: '已暫存到伺服器。暫存只有你和系辦看得到，不算正式分數。' })
    } catch {
      setMessage({ tone: 'error', text: '連線中斷，暫存可能沒有存到；請再按一次「暫存」。' })
    } finally {
      setBusy(null)
    }
  }

  async function onSubmit() {
    confirmDialog.current?.close()
    setBusy('submit')
    setMessage(null)
    try {
      const outcome = await submitGradingAction(assignmentId, values, requestIds.current.submit)
      if (!outcome.ok) {
        requestIds.current.submit = newRequestId()
        setMessage({ tone: 'error', text: outcome.message })
        setServerBad(outcome.fields ?? [])
        if (outcome.code === 'CONFLICT') router.refresh()
        return
      }
      requestIds.current.submit = newRequestId()
      setReceipt(outcome.data)
      setLocked(true)
      setDirty(false)
      receiptDialog.current?.showModal()
    } catch {
      // 不換請求編號：再按一次如果其實已經送到，伺服器會回同一張回執，不會多一筆。
      setMessage({ tone: 'error', text: '連線中斷，不確定有沒有送到；請再按一次「正式送出」，不會重複計分。' })
    } finally {
      setBusy(null)
    }
  }

  const status = isLocked
    ? `已正式送出 ${receipt?.receivedAtText ?? submittedAtText ?? ''}`
    : busy === 'save'
      ? '儲存中…'
      : dirty
        ? '有尚未暫存的修改'
        : savedText
          ? `已儲存 ${savedText}（伺服器時間）`
          : '尚未儲存'

  return (
    <section aria-label={`${groupCode}「${stage.name}」評分表`} className="rounded-card border border-border bg-background">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3">
        <p className="text-sm font-semibold text-ink">
          {stage.name}
          <span className="ml-2 text-xs font-normal text-muted-foreground">占總成績 {stage.weight}%</span>
        </p>
        <p role="status" aria-live="polite" data-testid="save-status" className="text-xs text-muted-foreground tabular-nums">
          {status}
        </p>
      </div>
      {draftFromOlderVersion && !isLocked ? (
        <p className="border-b border-border bg-primary-subtle px-5 py-2 text-xs text-primary-on-subtle">
          系辦在你暫存之後更新了評分方案；已對應的分數保留，請確認後再暫存。
        </p>
      ) : null}

      <ol className="px-5">
        {stage.items.map((item, index) => {
          const value = values[item.key] ?? ''
          const error = errors.get(item.key) ?? (serverBad.includes(item.key) ? '請檢查這一項' : null)
          const id = `score-${item.key}`
          return (
            <li
              key={item.key}
              className="grid grid-cols-1 items-center gap-2 border-t border-border py-4 first:border-t-0 sm:grid-cols-[minmax(0,1fr)_16rem]"
            >
              <div>
                <label htmlFor={id} className="block text-[15px] font-semibold text-ink">
                  {index + 1}. {item.name}
                </label>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {item.type === 'number'
                    ? `滿分 ${item.max}・占 ${item.weight}%`
                    : item.type === 'letter'
                      ? `等第 A–F・占 ${item.weight}%`
                      : '通過／不通過（不計入分數）'}
                </p>
              </div>
              <div>
                {item.type === 'number' ? (
                  <div className="flex items-baseline gap-2">
                    <input
                      id={id}
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      value={value}
                      disabled={isLocked}
                      placeholder={`0–${item.max}`}
                      aria-invalid={error ? true : undefined}
                      aria-describedby={error ? `${id}-error` : undefined}
                      onChange={(e) => set(item.key, e.target.value)}
                      className={cn(
                        'h-11 w-28 rounded-md border bg-background px-3 text-center text-lg font-semibold tabular-nums disabled:bg-muted',
                        error ? 'border-danger text-danger' : 'border-border',
                      )}
                    />
                    <span className="text-sm text-muted-foreground tabular-nums">/ {item.max}</span>
                  </div>
                ) : (
                  <div role="radiogroup" aria-labelledby={`${id}-label`} id={id} className="flex gap-1">
                    <span id={`${id}-label`} className="sr-only">
                      {item.name}
                    </span>
                    {(item.type === 'letter'
                      ? LETTER_GRADES.map((g) => ({ value: g, label: g }))
                      : [
                          { value: 'pass', label: '通過' },
                          { value: 'fail', label: '不通過' },
                        ]
                    ).map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={value === option.value}
                        disabled={isLocked}
                        onClick={() => set(item.key, option.value)}
                        className={cn(
                          'h-11 flex-1 rounded-md text-sm font-semibold disabled:opacity-60',
                          value === option.value ? 'bg-primary text-primary-foreground' : 'bg-muted text-ink hover:bg-border',
                        )}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                )}
                {error ? (
                  <p id={`${id}-error`} className="mt-1 text-xs font-semibold text-danger">
                    {error}
                  </p>
                ) : null}
              </div>
            </li>
          )
        })}
      </ol>

      <div className="space-y-3 border-t border-border px-5 py-4">
        <p className="text-sm tabular-nums" data-testid="score-preview">
          <span className="text-muted-foreground">{isLocked ? '正式採計' : '預覽總分'}</span>{' '}
          <b className="text-lg text-ink">{isLocked && (receipt?.teacherScore ?? finalScore) ? (receipt?.teacherScore ?? finalScore) : formatScore(result.score)}</b>
          <span className="text-muted-foreground"> / 100</span>
          {result.gate === 'fail' ? <span className="ml-2 text-xs font-semibold text-danger">有項目不通過</span> : null}
        </p>
        <p className="text-xs text-muted-foreground">
          {isLocked
            ? '已正式送出並鎖定；要修改請聯絡系辦退回。'
            : errors.size > 0
              ? `${[...errors.values()][0]}，修正後才能正式送出。`
              : missing > 0
                ? `還差 ${missing} 項，填齊後才能正式送出。`
                : '每一項都有效，可以正式送出。'}
        </p>
        {message ? (
          <p
            role={message.tone === 'ok' ? 'status' : 'alert'}
            className={cn(
              'rounded-md px-3 py-2 text-sm',
              message.tone === 'ok' ? 'bg-primary-subtle text-primary-on-subtle' : 'bg-danger-subtle text-danger-on-subtle',
            )}
          >
            {message.text}
          </p>
        ) : null}
        {!isLocked ? (
          <div className="flex flex-wrap gap-2">
            <button type="button" className={SECONDARY} onClick={onSave} disabled={busy !== null}>
              {busy === 'save' ? '暫存中…' : '暫存'}
            </button>
            <button
              type="button"
              className={PRIMARY}
              onClick={() => confirmDialog.current?.showModal()}
              disabled={!complete || busy !== null}
            >
              {busy === 'submit' ? '送出中…' : '正式送出'}
            </button>
          </div>
        ) : null}
      </div>

      <dialog
        ref={confirmDialog}
        aria-label="確認正式送出"
        className="m-auto w-[min(26rem,calc(100vw-2rem))] rounded-card border border-border bg-background p-0 backdrop:bg-ink/40"
      >
        <div className="space-y-3 p-5">
          <h2 className="text-base font-semibold text-ink">
            正式送出 {groupCode}「{stage.name}」？
          </h2>
          <p className="text-sm text-muted-foreground">
            送出後分數就鎖定，不能再改；要修改需系辦退回。這一份分數是 <b className="text-ink tabular-nums">{formatScore(result.score)}</b>。
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" className={SECONDARY} onClick={() => confirmDialog.current?.close()}>
              再看一下
            </button>
            <button type="button" className={PRIMARY} onClick={onSubmit}>
              確認送出
            </button>
          </div>
        </div>
      </dialog>

      <dialog
        ref={receiptDialog}
        aria-label="已收件"
        className="m-auto w-[min(24rem,calc(100vw-2rem))] rounded-card border border-border bg-background p-0 backdrop:bg-ink/40"
      >
        {receipt ? (
          <div className="flex flex-col items-center gap-3 p-6 text-center">
            <span className="-rotate-2 rounded-md border-2 border-primary px-3 py-1 text-sm font-bold tracking-widest text-primary">已收件</span>
            <h2 className="text-lg font-semibold text-ink">
              {receipt.groupCode}・{receipt.stageName}
            </h2>
            <p className="text-sm text-muted-foreground tabular-nums">收件時間 {receipt.receivedAtText}</p>
            <p className="text-sm text-muted-foreground tabular-nums">
              正式採計 <b className="text-3xl text-ink">{receipt.teacherScore}</b> / 100
            </p>
            <p className="text-xs text-muted-foreground">已鎖定。多位老師時以算術平均計入階段成績；學生看不到分數。</p>
            <button type="button" className={SECONDARY} onClick={() => receiptDialog.current?.close()}>
              知道了
            </button>
          </div>
        ) : null}
      </dialog>
    </section>
  )
}
