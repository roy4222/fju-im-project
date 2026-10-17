'use client'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { IconAlertCircle, IconCheck, IconDeviceFloppy, IconSend } from '@tabler/icons-react'
import { saveGradingDraftAction, submitGradingAction } from './actions'
import { COMMENT_MAX, commentLength, type SubmissionRecord } from '@/app/dashboard/teacher/grading/[groupId]/bench-types'
import type { FinalReceiptView } from '@/app/dashboard/teacher/grading/types'
import { blockReason as blockReasonOf, CONFIRM_NOTE, itemErrors, missingCount, missingText, PASS_FAIL_OPTIONS, RECEIPT_NOTE, SAVED_NOTE } from '@/app/dashboard/teacher/grading/rules'
import { DIALOG, GHOST_BUTTON, OUTLINE_BUTTON, Pill, PRIMARY_BUTTON, StampMark } from '@/app/dashboard/teacher/_ui/dash'
import type { SchemeStage } from '@/application/grading'
import { cn } from '@/shared/cn'
import { formatScore, LETTER_GRADES, teacherStageScore } from '@/shared/score'

/**
 * 單組評分頁右欄的評分卡（票 23、37；TE-06b 照 Q78 重做：數字項「／滿分」、等第下拉、通過制兩選一、
 * 「還有 N 項沒填」、儲存草稿／正式送出；手機寬度動作列固定在畫面底部）。規則與字樣在 `rules.ts`。
 *
 * - 分數即時驗證與預覽總分只在瀏覽器（和伺服器同一份算式 `@/shared/score`），**伺服器再驗一次**才算數。
 * - 「儲存草稿」可以沒填完；只有本人與系辦看得到，不算正式分數。
 * - 「正式送出」要每一項都有效，先確認再送；送出後拿到收件章。
 * - 正式送出後（B 階段 TE-B1）欄位仍可改：「儲存草稿」不動正式成績（狀態列出現「有尚未送出的修改」），
 *   「重新送出」以這一次為準、上一次改列歷史；「送出紀錄」列每一次送出時間。
 * - 評語（TE-B4）跟分數同一次存，最多 500 字：超過就在瀏覽器擋下、不送請求（伺服器另外也擋）。
 * - 系辦結算這一階段後（TE-B2b）全部唯讀、不顯示任何按鈕。
 * - 同一次送出（連點、斷線重試）帶同一個請求編號，伺服器只算一次；內容一改就換新編號。
 */

/** 結算後的說明（設計方案 §2.5）。 */
const SETTLED_NOTE = '這個階段成績已由系辦結算，如需修改請聯絡系辦。'
/** 重新送出的確認說明。 */
const RESUBMIT_NOTE = '送出後以這一次為準，上一次送出的分數改列為歷史紀錄。'
/** 正式送出後再儲存草稿的訊息。 */
const SAVED_AFTER_FINAL_NOTE = '已儲存草稿。計入成績的仍是上一次送出的分數，按「重新送出」才會更新。'

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
  initialComment,
  hasFinal,
  readOnly,
  settledAtText,
  draftAfterFinal,
  submissionHistory,
  savedAtText,
  finalScore,
  draftFromOlderVersion,
  eyebrow,
  members,
  children,
}: {
  assignmentId: string
  groupCode: string
  stage: SchemeStage
  initialScores: Readonly<Record<string, string>>
  initialComment: string | null
  /** 已有一筆採計（正式送出過、沒被退回）。 */
  hasFinal: boolean
  /** 不能再改：階段已結算（或已採計但不能重送）。伺服器判，重新整理會跟著變。 */
  readOnly: boolean
  /** 系辦結算時間；沒結算是 null。 */
  settledAtText: string | null
  /** 正式送出後又存了草稿、還沒重新送出。 */
  draftAfterFinal: boolean
  /** 第 1 次…第 n 次正式送出（舊的在前）。 */
  submissionHistory: readonly SubmissionRecord[]
  savedAtText: string | null
  finalScore: string | null
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
  const [comment, setComment] = useState(initialComment ?? '')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<'save' | 'submit' | null>(null)
  const [savedText, setSavedText] = useState(savedAtText)
  const [message, setMessage] = useState<{ tone: 'ok' | 'info' | 'error'; text: string } | null>(null)
  const [serverBad, setServerBad] = useState<readonly string[]>([])
  const [receipt, setReceipt] = useState<FinalReceiptView | null>(null)
  // 送出後先在這裡更新（不用等 router.refresh 回來）；元件用 assignmentId 當 key，重抓不會重建，
  // 所以伺服器資料一變（下面的 snapshot），就照伺服器重新同步。
  const [final, setFinal] = useState(hasFinal)
  const [counted, setCounted] = useState(finalScore)
  const [history, setHistory] = useState(submissionHistory)
  const [pendingEdit, setPendingEdit] = useState(draftAfterFinal)

  // 伺服器才是事實（Review #584）：每次 router.refresh 帶回不同的資料，就把本地狀態對齊伺服器。
  // - 採計、送出次數與紀錄、正式送出後的草稿、儲存時間：一律換成伺服器的（別的分頁重送過也會跟上）。
  // - 分數與評語：沒有未存的修改、或已經唯讀（結算後被拒存）時，換回伺服器存的；不把沒存成功的內容顯示成已存。
  //   還有未存的修改而且仍可編輯時保留輸入，讓老師自己決定要不要存。
  // - 送出次數跟這裡以為的不一樣（別的分頁或裝置重送過）：提示一聲。
  const snapshot = JSON.stringify([initialScores, initialComment, hasFinal, readOnly, settledAtText, draftAfterFinal, submissionHistory, savedAtText, finalScore])
  const [syncedSnapshot, setSyncedSnapshot] = useState(snapshot)
  if (syncedSnapshot !== snapshot) {
    setSyncedSnapshot(snapshot)
    setFinal(hasFinal)
    setCounted(finalScore)
    setHistory(submissionHistory)
    setPendingEdit(draftAfterFinal)
    setSavedText(savedAtText)
    if (!dirty || readOnly) {
      setValues({ ...initialScores })
      setComment(initialComment ?? '')
      setDirty(false)
      setServerBad([])
    }
    if (submissionHistory.length !== history.length) {
      setMessage({
        tone: 'info',
        text: hasFinal
          ? `這一份評分在別的分頁或裝置已送出到第 ${submissionHistory.length} 次，畫面已更新為最新狀態。`
          : '這一份評分在別的地方有更新，畫面已更新為最新狀態。',
      })
    }
  }
  const requestIds = useRef({ save: newRequestId(), submit: newRequestId() })
  const confirmDialog = useRef<HTMLDialogElement>(null)
  const receiptDialog = useRef<HTMLDialogElement>(null)
  const inputs = useRef<Record<string, HTMLElement | null>>({})

  // 回到這個分頁時重抓一次：別的分頁或裝置送出過，這裡的次數、紀錄與唯讀狀態才會跟上。
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') router.refresh()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [router])

  // 還有沒存的輸入時，離開頁面先問一聲。
  useEffect(() => {
    if (!dirty || readOnly) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, readOnly])

  const result = teacherStageScore(stage.items, stage.letterMap, values)
  const errors = itemErrors(stage.items, values)
  const missing = missingCount(stage.items, values)
  const commentError = commentLength(comment) > COMMENT_MAX ? `評語最多 ${COMMENT_MAX} 字` : null
  const complete = missing === 0 && errors.size === 0 && commentError === null
  // 沒有改過（或唯讀）時顯示計入成績的分數；正式送出後又改了，顯示新分數的預覽。
  const showCounted = final && counted !== null && (readOnly || (!dirty && !pendingEdit))
  const shownScore = showCounted ? counted : formatScore(result.score)
  const submitWord = final ? '重新送出' : '正式送出'
  const percent = Math.max(0, Math.min(100, Number(shownScore) || 0))

  function touched() {
    setDirty(true)
    // 內容變了就是新的一次儲存／送出：換新的請求編號（舊編號配新內容會被當成 REQUEST_MISMATCH）。
    requestIds.current = { save: newRequestId(), submit: newRequestId() }
  }

  function set(key: string, value: string) {
    setValues((v) => ({ ...v, [key]: value }))
    setServerBad((list) => list.filter((k) => k !== key))
    touched()
  }

  function focusFirstMissing() {
    const item = stage.items.find((i) => !values[i.key] || errors.has(i.key))
    if (item) inputs.current[item.key]?.focus()
  }

  async function onSave() {
    if (errors.size > 0 || commentError) {
      setMessage({ tone: 'error', text: `${errors.size > 0 ? [...errors.values()][0] : commentError}，修正後才能儲存草稿。` })
      return
    }
    setBusy('save')
    setMessage(null)
    try {
      const outcome = await saveGradingDraftAction(assignmentId, values, comment, requestIds.current.save)
      requestIds.current.save = newRequestId()
      if (!outcome.ok) {
        setMessage({ tone: 'error', text: outcome.message })
        setServerBad(outcome.fields ?? [])
        // 被拒（已結算、被退回、指派失效…）：重抓伺服器的事實，上面的 snapshot 同步會把畫面對齊。
        router.refresh()
        return
      }
      setSavedText(outcome.data.savedAtText)
      setDirty(false)
      if (final) setPendingEdit(true)
      setMessage({ tone: 'ok', text: final ? SAVED_AFTER_FINAL_NOTE : SAVED_NOTE })
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
      const outcome = await submitGradingAction(assignmentId, values, comment, requestIds.current.submit)
      if (!outcome.ok) {
        requestIds.current.submit = newRequestId()
        setMessage({ tone: 'error', text: outcome.message })
        setServerBad(outcome.fields ?? [])
        // 被拒（已結算、被退回、指派失效…）：重抓伺服器的事實，上面的 snapshot 同步會把畫面對齊。
        router.refresh()
        return
      }
      requestIds.current.submit = newRequestId()
      setReceipt(outcome.data)
      setFinal(true)
      setCounted(outcome.data.teacherScore)
      // 先記一筆讓畫面立刻有反應；下面 router.refresh 回來會換成伺服器的完整紀錄（次數以伺服器為準）。
      setHistory((list) => [...list, { no: list.length + 1, atText: outcome.data.receivedAtText }])
      setPendingEdit(false)
      setDirty(false)
      receiptDialog.current?.showModal()
      router.refresh()
    } catch {
      // 不換請求編號：再按一次如果其實已經送到，伺服器會回同一張回執，不會多一筆。
      setMessage({ tone: 'error', text: `連線中斷，不確定有沒有送到；請再按一次「${submitWord}」，不會重複計分。` })
    } finally {
      setBusy(null)
    }
  }

  const last = history.at(-1)
  // 送出前：save-status 是頂端一列的小字；送出後：save-status 是頂部的綠色橫條，草稿狀態另外在頂端一列。
  const finalStatus = `已正式送出（第 ${last?.no ?? 1} 次）${last ? `・${last.atText}` : ''}${readOnly ? '' : '，可再修改後重新送出'}`
  const draftStatus =
    busy === 'save'
      ? '儲存中…'
      : dirty
        ? '有尚未儲存的修改'
        : final
          ? null
          : readOnly
            ? '已結算，不能再改'
            : savedText
              ? `已儲存・系統記錄的儲存時間 ${savedText}`
              : '尚未儲存'
  const dot: SaveDotState = readOnly ? 'locked' : busy === 'save' ? 'saving' : dirty ? 'dirty' : savedText ? 'saved' : 'unsaved'
  const blockReason = readOnly
    ? settledAtText
      ? SETTLED_NOTE
      : '已正式送出，分數已計入階段成績。'
    : errors.size === 0 && missing === 0 && commentError
      ? `${commentError}，刪短後才能${submitWord}。`
      : blockReasonOf(errors, missing).replace('正式送出', submitWord)

  return (
    <section aria-label={`${groupCode}「${stage.name}」評分表`} className="dash-card">
      {/* 送出後：頂部一條綠色「已正式送出（第 n 次）・{時間}」（就是 save-status 本身） */}
      {final ? (
        <p
          role="status"
          aria-live="polite"
          data-testid="save-status"
          className="tabular flex items-center gap-2 rounded-t-[18px] bg-success-subtle px-5 py-2.5 text-sm font-semibold text-success-on-subtle"
        >
          <IconCheck className="size-4 shrink-0" strokeWidth={3} aria-hidden />
          {finalStatus}
        </p>
      ) : null}
      {/* 頂端一列：組別＋儲存狀態 */}
      <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-card px-5 py-3', final ? null : 'rounded-t-[18px]')}>
        {/* 窄螢幕：組別這一塊獨占一行、儲存狀態換到下一行，eyebrow 才不會被擠成直排。 */}
        <div className="min-w-0 flex-1 basis-full sm:basis-0">
          <p className="tabular truncate text-xs font-semibold text-muted-foreground">{eyebrow}</p>
          <h2 className="truncate text-lg font-extrabold text-ink">{groupCode}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {settledAtText ? (
            <Pill tone="default" testId="settled-pill">
              已結算
            </Pill>
          ) : null}
          {final && !readOnly && pendingEdit && !dirty && busy !== 'save' ? (
            <Pill tone="brand" testId="draft-after-final">
              有尚未送出的修改
            </Pill>
          ) : null}
          {draftStatus ? (
            <p
              role="status"
              aria-live="polite"
              data-testid={final ? 'edit-status' : 'save-status'}
              className="tabular inline-flex items-center gap-2 text-xs font-medium"
            >
              <SaveDot state={dot} />
              <span className={dot === 'saved' ? 'text-foreground' : 'text-muted-foreground'}>{draftStatus}</span>
            </p>
          ) : null}
        </div>
      </div>
      <p className="truncate px-5 pt-3 text-xs text-muted-foreground">{members}</p>
      {children ? <div className="flex flex-col gap-2 px-5 pt-3">{children}</div> : null}
      {settledAtText ? (
        <p data-testid="settled-notice" className="tabular mx-5 mt-3 rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
          {SETTLED_NOTE}（結算時間 {settledAtText}）
        </p>
      ) : null}
      {draftFromOlderVersion && !readOnly ? (
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
                      disabled={readOnly}
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
                    disabled={readOnly}
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
                        disabled={readOnly}
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
                {readOnly ? (
                  <span className="text-muted-foreground">{settledAtText ? '已結算' : '已計入成績'}</span>
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
      <div className="flex flex-col gap-1.5 border-t border-border px-5 py-4">
        <label htmlFor="bench-comment" className="text-[15px] font-semibold text-foreground">
          評語（選填，最多 {COMMENT_MAX} 字）
        </label>
        <textarea
          id="bench-comment"
          value={comment}
          disabled={readOnly}
          rows={3}
          aria-invalid={commentError ? true : undefined}
          aria-describedby="bench-comment-count"
          onChange={(e) => {
            setComment(e.target.value)
            touched()
          }}
          className={cn(
            'min-h-20 rounded-lg border bg-background px-3 py-2 text-sm outline-none transition-[border-color,box-shadow] duration-150 focus-visible:ring-3 disabled:bg-muted disabled:opacity-70',
            commentError
              ? 'border-destructive focus-visible:ring-destructive/25'
              : 'border-input focus-visible:border-primary focus-visible:ring-primary/25',
          )}
        />
        <p id="bench-comment-count" className="tabular flex items-center justify-between gap-2 text-xs">
          {commentError ? (
            <span data-testid="comment-error" className="inline-flex items-center gap-1 font-semibold text-destructive">
              <IconAlertCircle className="size-3.5" />
              {commentError}
            </span>
          ) : (
            <span className="text-muted-foreground">只有你和系辦看得到。</span>
          )}
          <span className={commentError ? 'font-semibold text-destructive' : 'text-muted-foreground'}>
            {commentLength(comment)}／{COMMENT_MAX}
          </span>
        </p>
      </div>
      {history.length > 0 ? (
        <details data-testid="submit-history" className="border-t border-border px-5 py-3 text-sm">
          <summary className="cursor-pointer font-semibold text-foreground">送出紀錄（{history.length} 次）</summary>
          <ol className="mt-2 flex flex-col gap-1">
            {history.map((h) => (
              <li key={h.no} className="tabular text-muted-foreground">
                第 {h.no} 次送出・{h.atText}
                {final && h.no === history.length ? '（目前採計）' : ''}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      {/* 底部：預覽總分＋動作。手機寬度固定在畫面底部（頁面底部已留空，不會蓋住最後一項）。 */}
      <div
        data-testid="bench-actions"
        className={cn(
          'rounded-b-[18px] border-t border-border bg-card',
          readOnly ? null : 'max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-30 max-lg:rounded-none max-lg:shadow-[0_-4px_16px_rgb(0_0_0/0.08)]',
        )}
      >
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-5 pt-3">
          <p className="tabular text-sm" data-testid="score-preview">
            <span className="text-muted-foreground">{showCounted ? '計入成績的分數' : '預覽總分'}</span>{' '}
            <b className="text-[17px] font-extrabold text-foreground">{shownScore}</b>
            <span className="text-muted-foreground"> / 100</span>
            {result.gate === 'fail' && !showCounted ? <span className="ml-2 text-xs font-semibold text-destructive">有項目不通過</span> : null}
            {final && !showCounted && counted !== null ? <span className="ml-2 text-xs text-muted-foreground">（目前計入 {counted}）</span> : null}
          </p>
          <div className="min-w-[120px] flex-1">
            <svg viewBox="0 0 100 4" preserveAspectRatio="none" width="100%" height="4" aria-hidden className="block overflow-hidden rounded-full">
              <rect x="0" y="0" width="100" height="4" fill="var(--muted)" />
              <rect x="0" y="0" width={percent} height="4" fill="var(--ink)" />
            </svg>
          </div>
          {!readOnly && (missing > 0 || errors.size > 0) ? (
            <button type="button" onClick={focusFirstMissing} className="tabular text-xs font-semibold text-ink underline-offset-2 hover:underline">
              {errors.size > 0 ? `${errors.size} 項需修正` : missingText(missing)}
            </button>
          ) : null}
        </div>
        {message ? (
          <p
            role={message.tone === 'error' ? 'alert' : 'status'}
            data-testid={message.tone === 'info' ? 'bench-stale' : undefined}
            className={cn(
              'mx-5 mt-3 rounded-lg px-3 py-2 text-sm',
              message.tone === 'ok'
                ? 'bg-success-subtle text-success-on-subtle'
                : message.tone === 'info'
                  ? 'bg-primary-subtle text-primary-on-subtle'
                  : 'bg-destructive-subtle text-destructive-on-subtle',
            )}
          >
            {message.text}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3 px-5 py-3">
          <span className="min-w-0 basis-full text-xs text-muted-foreground sm:flex-1 sm:basis-auto">{blockReason}</span>
          {!readOnly ? (
            <div className="flex w-full gap-2 sm:w-auto">
              <button type="button" className={cn(OUTLINE_BUTTON, 'h-11 flex-1 px-4 sm:flex-none')} onClick={onSave} disabled={busy !== null}>
                <IconDeviceFloppy /> {busy === 'save' ? '儲存中…' : '儲存草稿'}
              </button>
              <button
                type="button"
                data-testid={final ? 'resubmit' : undefined}
                className={cn(PRIMARY_BUTTON, 'flex-1 px-4 sm:flex-none')}
                onClick={() => confirmDialog.current?.showModal()}
                disabled={!complete || busy !== null}
                title={complete ? undefined : blockReason}
              >
                <IconSend /> {busy === 'submit' ? '送出中…' : submitWord}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <dialog ref={confirmDialog} aria-label={`確認${submitWord}`} className={cn(DIALOG, 'w-[min(24rem,calc(100vw-2rem))]')}>
        <div className="flex flex-col gap-3 p-6">
          <h2 className="text-lg font-extrabold text-foreground">
            {submitWord} {groupCode}「{stage.name}」？
          </h2>
          <p className="text-sm text-muted-foreground">
            這一份分數是 <b className="tabular text-foreground">{formatScore(result.score)}</b>。{final ? RESUBMIT_NOTE : CONFIRM_NOTE}
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
