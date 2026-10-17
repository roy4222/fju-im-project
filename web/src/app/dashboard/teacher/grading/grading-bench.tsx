'use client'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { IconAlertCircle, IconCheck, IconDeviceFloppy, IconSend } from '@tabler/icons-react'
import { saveGradingDraftAction, submitGradingAction } from './actions'
import type { FinalReceiptView } from '@/app/dashboard/teacher/grading/types'
import { blockReason as blockReasonOf, CONFIRM_NOTE, itemErrors, missingCount, missingText, PASS_FAIL_OPTIONS, RECEIPT_NOTE, SAVED_NOTE } from '@/app/dashboard/teacher/grading/rules'
import { DIALOG, GHOST_BUTTON, OUTLINE_BUTTON, PRIMARY_BUTTON, StampMark } from '@/app/dashboard/teacher/_ui/dash'
import type { SchemeStage } from '@/application/grading'
import { cn } from '@/shared/cn'
import { formatScore, LETTER_GRADES, teacherStageScore } from '@/shared/score'

/**
 * 單組評分頁右欄的評分卡（票 23、37；TE-06b 照 Q78 重做：數字項「／滿分」、等第下拉、通過制兩選一、
 * 「還有 N 項沒填」、儲存草稿／正式送出；手機寬度動作列固定在畫面底部）。規則與字樣在 `rules.ts`。
 *
 * - 分數即時驗證與預覽總分只在瀏覽器（和伺服器同一份算式 `@/shared/score`），**伺服器再驗一次**才算數。
 * - 「儲存草稿」可以沒填完；只有本人與系辦看得到，不算正式分數。
 * - 「正式送出」要每一項都有效，先確認再送；送出後拿到收件章、欄位變唯讀（A 階段守衛沒變；自己重送是 B 的 TE-B1）。
 * - 同一次送出（連點、斷線重試）帶同一個請求編號，伺服器只算一次；內容一改就換新編號。
 */

const newRequestId = () => crypto.randomUUID()

type SaveDotState = 'unsaved' | 'saving' | 'saved' | 'dirty' | 'locked'

/** 原型的儲存狀態小圓點：空心＝還沒存、實心綠＝已存。 */
function SaveDot({ state }: { state: SaveDotState }) {
  const cls = {
    unsaved: 'border-[1.5px] border-muted-foreground',
    dirty: 'border-[1.5px] border-muted-foreground',
    saving: 'bg-muted-foreground/60',
    saved: 'bg-success',
    locked: 'bg-success',
  }[state]
  return <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', cls)} />
}

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
  eyebrow,
  members,
  children,
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
  /** 頂端組別上面那一行小字（屆別・階段・方案版本）。 */
  eyebrow: string
  /** 組員姓名（一行）。 */
  members: string
  /** 放在組員下面的東西：階段切換、退回理由。 */
  children?: ReactNode
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
  const inputs = useRef<Record<string, HTMLElement | null>>({})

  // 還有沒存的輸入時，離開頁面先問一聲。
  useEffect(() => {
    if (!dirty || isLocked) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, isLocked])

  const result = teacherStageScore(stage.items, stage.letterMap, values)
  const errors = itemErrors(stage.items, values)
  const missing = missingCount(stage.items, values)
  const complete = missing === 0 && errors.size === 0
  const shownScore = isLocked && (receipt?.teacherScore ?? finalScore) ? (receipt?.teacherScore ?? finalScore)! : formatScore(result.score)
  const percent = Math.max(0, Math.min(100, Number(shownScore) || 0))

  function set(key: string, value: string) {
    setValues((v) => ({ ...v, [key]: value }))
    setDirty(true)
    setServerBad((list) => list.filter((k) => k !== key))
    // 內容變了就是新的一次儲存／送出：換新的請求編號（舊編號配新內容會被當成 REQUEST_MISMATCH）。
    requestIds.current = { save: newRequestId(), submit: newRequestId() }
  }

  function focusFirstMissing() {
    const item = stage.items.find((i) => !values[i.key] || errors.has(i.key))
    if (item) inputs.current[item.key]?.focus()
  }

  async function onSave() {
    if (errors.size > 0) {
      setMessage({ tone: 'error', text: `${[...errors.values()][0]}，修正後才能儲存草稿。` })
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
      setMessage({ tone: 'ok', text: SAVED_NOTE })
      // 頁首自己的狀態 Pill（`my-status`）是伺服器元件：重抓一次讓「草稿 已填／總數」跟著變（N-154）。
      // 這個元件用 assignmentId 當 key，重抓不會重建，表單上的輸入與訊息都留著。
      router.refresh()
    } catch {
      setMessage({ tone: 'error', text: '連線中斷，草稿可能沒有存到；請再按一次「儲存草稿」。' })
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
      router.refresh()
    } catch {
      // 不換請求編號：再按一次如果其實已經送到，伺服器會回同一張回執，不會多一筆。
      setMessage({ tone: 'error', text: '連線中斷，不確定有沒有送到；請再按一次「正式送出」，不會重複計分。' })
    } finally {
      setBusy(null)
    }
  }

  const submittedText = receipt?.receivedAtText ?? submittedAtText
  const status = isLocked
    ? `已正式送出${submittedText ? `・${submittedText}` : ''}`
    : busy === 'save'
      ? '儲存中…'
      : dirty
        ? '有尚未儲存的修改'
        : savedText
          ? `已儲存・系統記錄的儲存時間 ${savedText}`
          : '尚未儲存'
  const dot: SaveDotState = isLocked ? 'locked' : busy === 'save' ? 'saving' : dirty ? 'dirty' : savedText ? 'saved' : 'unsaved'
  const blockReason = isLocked ? '已正式送出，分數已計入階段成績。' : blockReasonOf(errors, missing)

  return (
    <section aria-label={`${groupCode}「${stage.name}」評分表`} className="dash-card">
      {/* 送出後：頂部一條綠色「已正式送出・{時間}」（就是 save-status 本身） */}
      {isLocked ? (
        <p
          role="status"
          aria-live="polite"
          data-testid="save-status"
          className="tabular flex items-center gap-2 rounded-t-[18px] bg-success-subtle px-5 py-2.5 text-sm font-semibold text-success-on-subtle"
        >
          <IconCheck className="size-4 shrink-0" strokeWidth={3} aria-hidden />
          {status}
        </p>
      ) : null}
      {/* 頂端一列：組別＋儲存狀態 */}
      <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-card px-5 py-3', isLocked ? null : 'rounded-t-[18px]')}>
        {/* 窄螢幕：組別這一塊獨占一行、儲存狀態換到下一行，eyebrow 才不會被擠成直排。 */}
        <div className="min-w-0 flex-1 basis-full sm:basis-0">
          <p className="tabular truncate text-xs font-semibold text-muted-foreground">{eyebrow}</p>
          <h2 className="truncate text-lg font-extrabold text-ink">{groupCode}</h2>
        </div>
        {!isLocked ? (
          <p role="status" aria-live="polite" data-testid="save-status" className="tabular inline-flex items-center gap-2 text-xs font-medium">
            <SaveDot state={dot} />
            <span className={dot === 'saved' ? 'text-foreground' : 'text-muted-foreground'}>{status}</span>
          </p>
        ) : null}
      </div>
      <p className="truncate px-5 pt-3 text-xs text-muted-foreground">{members}</p>
      {children ? <div className="flex flex-col gap-2 px-5 pt-3">{children}</div> : null}
      {draftFromOlderVersion && !isLocked ? (
        <p className="mx-5 mt-3 rounded-lg bg-primary-subtle px-3 py-2 text-xs text-primary-on-subtle">
          系辦在你儲存草稿之後更新了評分規則；已對應的分數保留，請確認後再儲存草稿。
        </p>
      ) : null}

      {/* 項目列：名稱＋占比｜輸入｜狀態 */}
      <ol className="px-5 pt-2 pb-2">
        {stage.items.map((item, index) => {
          const value = values[item.key] ?? ''
          const error = errors.get(item.key) ?? (serverBad.includes(item.key) ? '請檢查這一項' : null)
          const filled = value !== '' && !error
          const id = `score-${item.key}`
          const name = `${index + 1}. ${item.name}`
          return (
            <li key={item.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 border-t border-border py-4 first:border-t-0">
              <div className="col-span-2 min-w-0">
                {item.type === 'passfail' ? (
                  <p id={`${id}-name`} className="text-[15px] font-semibold text-foreground">
                    {name}
                  </p>
                ) : (
                  <label htmlFor={id} className="block text-[15px] font-semibold text-foreground">
                    {name}
                  </label>
                )}
                <p className="tabular text-xs text-muted-foreground">
                  {item.type === 'number'
                    ? `滿分 ${item.max}・占 ${item.weight}%`
                    : item.type === 'letter'
                      ? `等第 A–F・占 ${item.weight}%`
                      : '兩選一（不計入分數）'}
                </p>
              </div>
              <div className="min-w-0">
                {item.type === 'number' ? (
                  <div className="flex items-baseline gap-2">
                    <input
                      id={id}
                      ref={(el) => {
                        inputs.current[item.key] = el
                      }}
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
                        'tabular h-11 w-28 rounded-lg border bg-background px-3 text-center text-[18px] font-bold outline-none transition-[border-color,box-shadow] duration-150 focus-visible:ring-3 disabled:bg-muted disabled:opacity-70',
                        error
                          ? 'border-destructive text-destructive focus-visible:ring-destructive/25'
                          : 'border-input focus-visible:border-primary focus-visible:ring-primary/25',
                      )}
                    />
                    <span className="tabular text-sm text-muted-foreground">／{item.max}</span>
                  </div>
                ) : item.type === 'letter' ? (
                  <select
                    id={id}
                    ref={(el) => {
                      inputs.current[item.key] = el
                    }}
                    value={value}
                    disabled={isLocked}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? `${id}-error` : undefined}
                    onChange={(e) => set(item.key, e.target.value)}
                    className={cn(
                      'tabular h-11 w-40 rounded-lg border bg-background px-3 text-[15px] font-bold outline-none focus-visible:ring-3 disabled:bg-muted disabled:opacity-70',
                      error ? 'border-destructive focus-visible:ring-destructive/25' : 'border-input focus-visible:border-primary focus-visible:ring-primary/25',
                    )}
                  >
                    <option value="">選擇等第</option>
                    {LETTER_GRADES.map((g) => (
                      <option key={g} value={g}>
                        {g}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div role="radiogroup" aria-labelledby={`${id}-name`} id={id} className="inline-flex w-full max-w-60 gap-1 rounded-lg bg-muted p-1">
                    {PASS_FAIL_OPTIONS.map((option, optionIndex) => (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={value === option.value}
                        disabled={isLocked}
                        ref={(el) => {
                          if (optionIndex === 0) inputs.current[item.key] = el
                        }}
                        onClick={() => set(item.key, option.value)}
                        className={cn(
                          'press h-9 flex-1 rounded-md text-sm font-bold transition-colors duration-150 disabled:opacity-60',
                          value === option.value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                )}
                {error ? (
                  <p id={`${id}-error`} className="mt-1.5 inline-flex items-center gap-1 text-xs font-semibold text-destructive">
                    <IconAlertCircle className="size-3.5" />
                    {error}
                  </p>
                ) : null}
              </div>
              <div className="tabular text-right text-xs">
                {isLocked ? (
                  <span className="text-muted-foreground">已計入成績</span>
                ) : error ? (
                  <span className="font-semibold text-destructive">需修正</span>
                ) : filled ? (
                  <span className="inline-flex items-center gap-1 text-success-on-subtle">
                    <IconCheck className="size-3.5" strokeWidth={3} />
                    已填
                  </span>
                ) : (
                  <span className="text-muted-foreground">未填</span>
                )}
              </div>
            </li>
          )
        })}
      </ol>
      {/* 底部：預覽總分＋動作。手機寬度固定在畫面底部（頁面底部已留空，不會蓋住最後一項）。 */}
      <div
        data-testid="bench-actions"
        className={cn(
          'rounded-b-[18px] border-t border-border bg-card',
          isLocked ? null : 'max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-30 max-lg:rounded-none max-lg:shadow-[0_-4px_16px_rgb(0_0_0/0.08)]',
        )}
      >
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-5 pt-3">
          <p className="tabular text-sm" data-testid="score-preview">
            <span className="text-muted-foreground">{isLocked ? '計入成績的分數' : '預覽總分'}</span>{' '}
            <b className="text-[17px] font-extrabold text-foreground">{shownScore}</b>
            <span className="text-muted-foreground"> / 100</span>
            {result.gate === 'fail' ? <span className="ml-2 text-xs font-semibold text-destructive">有項目不通過</span> : null}
          </p>
          <div className="min-w-[120px] flex-1">
            <svg viewBox="0 0 100 4" preserveAspectRatio="none" width="100%" height="4" aria-hidden className="block overflow-hidden rounded-full">
              <rect x="0" y="0" width="100" height="4" fill="var(--muted)" />
              <rect x="0" y="0" width={percent} height="4" fill="var(--ink)" />
            </svg>
          </div>
          {!isLocked && (missing > 0 || errors.size > 0) ? (
            <button type="button" onClick={focusFirstMissing} className="tabular text-xs font-semibold text-ink underline-offset-2 hover:underline">
              {errors.size > 0 ? `${errors.size} 項需修正` : missingText(missing)}
            </button>
          ) : null}
        </div>
        {message ? (
          <p
            role={message.tone === 'ok' ? 'status' : 'alert'}
            className={cn(
              'mx-5 mt-3 rounded-lg px-3 py-2 text-sm',
              message.tone === 'ok' ? 'bg-success-subtle text-success-on-subtle' : 'bg-destructive-subtle text-destructive-on-subtle',
            )}
          >
            {message.text}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3 px-5 py-3">
          <span className="min-w-0 basis-full text-xs text-muted-foreground sm:flex-1 sm:basis-auto">{blockReason}</span>
          {!isLocked ? (
            <div className="flex w-full gap-2 sm:w-auto">
              <button type="button" className={cn(OUTLINE_BUTTON, 'h-11 flex-1 px-4 sm:flex-none')} onClick={onSave} disabled={busy !== null}>
                <IconDeviceFloppy /> {busy === 'save' ? '儲存中…' : '儲存草稿'}
              </button>
              <button
                type="button"
                className={cn(PRIMARY_BUTTON, 'flex-1 px-4 sm:flex-none')}
                onClick={() => confirmDialog.current?.showModal()}
                disabled={!complete || busy !== null}
                title={complete ? undefined : blockReason}
              >
                <IconSend /> {busy === 'submit' ? '送出中…' : '正式送出'}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <dialog ref={confirmDialog} aria-label="確認正式送出" className={cn(DIALOG, 'w-[min(24rem,calc(100vw-2rem))]')}>
        <div className="flex flex-col gap-3 p-6">
          <h2 className="text-lg font-extrabold text-foreground">
            正式送出 {groupCode}「{stage.name}」？
          </h2>
          <p className="text-sm text-muted-foreground">
            這一份分數是 <b className="tabular text-foreground">{formatScore(result.score)}</b>。{CONFIRM_NOTE}
          </p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <button type="button" className={cn(PRIMARY_BUTTON, 'h-10 flex-1')} onClick={onSubmit}>
              確認送出
            </button>
            <button type="button" className={cn(GHOST_BUTTON, 'h-10')} onClick={() => confirmDialog.current?.close()}>
              再看一下
            </button>
          </div>
        </div>
      </dialog>

      <dialog ref={receiptDialog} aria-label="已送出" className={cn(DIALOG, 'w-[min(24rem,calc(100vw-2rem))]')}>
        {receipt ? (
          <div className="flex flex-col items-center gap-4 p-6 text-center">
            <StampMark>
              <IconCheck className="size-4" strokeWidth={3} />
              已送出
            </StampMark>
            <div>
              <h2 className="text-lg font-extrabold text-foreground">
                {receipt.groupCode}・{receipt.stageName}
              </h2>
              <p className="tabular mt-1 text-sm text-muted-foreground">送出時間 {receipt.receivedAtText}</p>
            </div>
            <p className="tabular text-sm text-muted-foreground">
              計入成績的分數 <b className="text-[28px] font-extrabold text-foreground">{receipt.teacherScore}</b> / 100
            </p>
            <p className="text-xs text-muted-foreground">{RECEIPT_NOTE}</p>
            <button type="button" className={OUTLINE_BUTTON} onClick={() => receiptDialog.current?.close()}>
              知道了
            </button>
          </div>
        ) : null}
      </dialog>
    </section>
  )
}
