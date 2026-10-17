'use client'
import { useEffect, useReducer, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { IconAlertCircle, IconCheck, IconCopy, IconDeviceFloppy, IconSend } from '@tabler/icons-react'
import { saveGradingDraftAction, submitGradingAction } from './actions'
import { COMMENT_MAX, commentLength, type SubmissionRecord } from '@/app/dashboard/teacher/grading/[groupId]/bench-types'
import type { BenchOutcome, FinalReceiptView } from '@/app/dashboard/teacher/grading/types'
import { blockReason as blockReasonOf, CONFIRM_NOTE, itemErrors, missingCount, missingText, PASS_FAIL_OPTIONS, RECEIPT_NOTE, SAVED_NOTE } from '@/app/dashboard/teacher/grading/rules'
import { DIALOG, GHOST_BUTTON, OUTLINE_BUTTON, Pill, PRIMARY_BUTTON, StampMark } from '@/app/dashboard/teacher/_ui/dash'
import type { SchemeStage } from '@/application/grading'
import { cn } from '@/shared/cn'
import { formatScore, LETTER_GRADES, parseItemScore, teacherStageScore } from '@/shared/score'

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
 *
 * ## 狀態模型（Review #584 第 1、2 輪）：伺服器事實與編輯中的內容分開
 *
 * **伺服器事實**（已存的分數與評語、是否已採計、送出次數與紀錄、正式送出後有沒有草稿、儲存時間、是否結算）
 * 一律直接讀 props；元件用 assignmentId 當 key，`router.refresh()` 帶回新 props 不會重建元件。成功後**不在本地複製或
 * 推算**這些事實（次數不用「本地長度＋1」），只重抓一次讓 props 跟上；同一個請求編號重試時伺服器回同一張回執，畫面次數仍以
 * 伺服器為準，不會多一筆。
 *
 * **編輯中的內容**（`buffer`）另外放，配 `editVersion`（每次輸入 +1）與 `savedVersion`（伺服器已收到的版本）：
 * `dirty = editVersion !== savedVersion`。每個請求記下發出時的版本與內容（`sent`），成功回應只在版本沒變時清 dirty；
 * 回應期間續打的內容保留，狀態列仍標「有尚未儲存的修改」。
 *
 * **新 props 到（`server` 事件）**，照這個順序判：
 * 1. 比已套用的快照舊、或比最近一次成功寫入的伺服器時間舊（寫入前就發出的重抓）→ 丟掉，等更新的回來。
 * 2. 伺服器內容等於最近一次送出的內容（或同內容重送、次數有加）→ 是自己這次寫入到了：中斷／逾時那一次也在這裡確認
 *    「其實已送達」，版本沒變才清 dirty。
 * 3. 否則內容有變＝別的分頁或裝置改過：沒有未存修改就對齊並提示；有未存修改且仍可編輯 → 衝突提示讓老師選
 *    「改用伺服器的內容」或「保留我的修改」，不自動覆蓋。
 * 4. 變成唯讀（系辦結算）而且還有未存修改 → 未存內容收進 `stash` 顯示在提示區（可複製；解除結算後可恢復），
 *    唯讀欄位顯示伺服器存的值，不把沒存成功的內容鎖成唯讀。
 * 5. 次數變了而不是自己送的 → 提示「別的分頁或裝置已送出到第 N 次」。
 *
 * 事件 → state 的完整對照表在 PR #584 說明。
 */

/** 結算後的說明（設計方案 §2.5）。 */
const SETTLED_NOTE = '這個階段成績已由系辦結算，如需修改請聯絡系辦。'
/** 重新送出的確認說明。 */
const RESUBMIT_NOTE = '送出後以這一次為準，上一次送出的分數改列為歷史紀錄。'
/** 正式送出後再儲存草稿的訊息。 */
const SAVED_AFTER_FINAL_NOTE = '已儲存草稿。計入成績的仍是上一次送出的分數，按「重新送出」才會更新。'
/** 回應還沒回來前又改了內容：存到的是按下時的內容。 */
const SAVED_BUT_EDITED_NOTE = '已儲存你按下「儲存草稿」時的內容；之後改的還沒存，請再按一次「儲存草稿」。'
const SUBMITTED_BUT_EDITED_NOTE = '已送出你按下時的內容並計入成績；之後改的還沒存，可再「儲存草稿」或「重新送出」。'
/** 等伺服器回應最多這麼久；超過當成連線中斷（請求編號不換，再按一次會接到同一張回執）。 */
const RESPONSE_TIMEOUT_MS = 20_000

const newRequestId = () => crypto.randomUUID()
const subscribeNothing = () => () => {}

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

// ───────────── 本地 state：編輯中的內容 vs 伺服器快照 ─────────────

/** 一份分數＋評語。 */
type Content = { readonly values: Readonly<Record<string, string>>; readonly comment: string }

/** 伺服器事實的快照（從 props 來；只拿來比對「變了什麼」，畫面一律直接讀 props）。 */
type ServerSnapshot = {
  /** 全部事實序列化：變了才需要對齊。 */
  readonly key: string
  /** 這份資料在伺服器讀出的時間（ISO）；比已套用的舊就丟掉。 */
  readonly serverTime: string
  /** 伺服器存的分數與評語（正規化後，和 `normalizeContent` 同一種形狀）。 */
  readonly content: Content
  /** 正式送出的次數。 */
  readonly count: number
  readonly readOnly: boolean
  readonly savedAtText: string | null
}

/** 最近一次送出的寫入：回應前、或回應中斷／逾時後，等伺服器事實確認。 */
type SentWrite = {
  readonly kind: 'save' | 'submit'
  /** 發出時的編輯版本。 */
  readonly version: number
  /** 發出的內容（正規化後）。 */
  readonly content: Content
  /** 伺服器回成功的時間；還沒回應（中斷、逾時）是 null。 */
  readonly serverTime: string | null
}

type Message = { readonly tone: 'ok' | 'info' | 'error'; readonly text: string }

type Local = {
  readonly buffer: Content
  readonly editVersion: number
  readonly savedVersion: number
  readonly applied: ServerSnapshot
  readonly sent: SentWrite | null
  readonly busy: 'save' | 'submit' | null
  /** 儲存成功的回執先顯示在狀態列，props 的儲存時間跟上就不用了。 */
  readonly ack: { readonly savedAtText: string } | null
  /** 伺服器的新內容（別的分頁或裝置改的）與本地未存修改衝突，等老師選。 */
  readonly conflict: Content | null
  /** 轉唯讀時沒存進去的內容。 */
  readonly stash: Content | null
  /** 這次動作的結果（成功、被拒、中斷）。 */
  readonly message: Message | null
  /** 同步類提示（別的分頁送出過、上一次其實已送達、已結算…）。 */
  readonly notice: Message | null
  /** 伺服器指出有問題的項目。 */
  readonly serverBad: readonly string[]
}

type Event =
  | { type: 'edit'; key: string; value: string }
  | { type: 'edit-comment'; value: string }
  | { type: 'sending'; kind: 'save' | 'submit'; content: Content }
  | { type: 'sent-ok'; kind: 'save' | 'submit'; version: number; serverTime: string; savedAtText: string | null; text: string | null; textIfEdited: string }
  | { type: 'sent-rejected'; text: string; fields: readonly string[] }
  | { type: 'sent-interrupted'; text: string }
  | { type: 'server'; snapshot: ServerSnapshot }
  | { type: 'use-server' }
  | { type: 'keep-mine' }
  | { type: 'restore-stash' }
  | { type: 'drop-stash' }
  | { type: 'message'; message: Message | null }

/** 跟伺服器同一套正規化（數字去尾零、空白項拿掉、只有空白的評語當沒有），兩邊才比得出「一樣」。 */
function normalizeContent(stage: SchemeStage, content: Content): Content {
  const values: Record<string, string> = {}
  for (const item of stage.items) {
    const raw = (content.values[item.key] ?? '').trim()
    if (raw === '') continue
    const parsed = parseItemScore(item, raw)
    values[item.key] = parsed.ok ? parsed.value : raw
  }
  return { values, comment: content.comment.trim() === '' ? '' : content.comment }
}

const sameContent = (a: Content, b: Content) => JSON.stringify([a.values, a.comment]) === JSON.stringify([b.values, b.comment])

const staleNotice = (count: number): Message => ({
  tone: 'info',
  text: `這一份評分在別的分頁或裝置已送出到第 ${count} 次，畫面已更新為最新狀態。`,
})
const updatedNotice: Message = { tone: 'info', text: '這一份評分在別的地方有更新，畫面已更新為最新狀態。' }

function reduce(state: Local, event: Event): Local {
  switch (event.type) {
    case 'edit':
      return {
        ...state,
        buffer: { ...state.buffer, values: { ...state.buffer.values, [event.key]: event.value } },
        editVersion: state.editVersion + 1,
        serverBad: state.serverBad.filter((k) => k !== event.key),
      }
    case 'edit-comment':
      return { ...state, buffer: { ...state.buffer, comment: event.value }, editVersion: state.editVersion + 1 }
    case 'sending':
      return {
        ...state,
        busy: event.kind,
        message: null,
        sent: { kind: event.kind, version: state.editVersion, content: event.content, serverTime: null },
      }
    case 'sent-ok': {
      const edited = event.version !== state.editVersion
      return {
        ...state,
        busy: null,
        savedVersion: edited ? state.savedVersion : event.version,
        sent: state.sent ? { ...state.sent, serverTime: event.serverTime } : null,
        ack: event.savedAtText ? { savedAtText: event.savedAtText } : state.ack,
        message: edited ? { tone: 'info', text: event.textIfEdited } : event.text ? { tone: 'ok', text: event.text } : null,
        serverBad: [],
      }
    }
    case 'sent-rejected':
      return { ...state, busy: null, sent: null, message: { tone: 'error', text: event.text }, serverBad: event.fields }
    case 'sent-interrupted':
      // `sent` 留著：之後重抓回來的內容對得上，就知道其實已經送到。
      return { ...state, busy: null, message: { tone: 'error', text: event.text } }
    case 'server':
      return onServer(state, event.snapshot)
    case 'use-server':
      return {
        ...state,
        buffer: state.applied.content,
        savedVersion: state.editVersion,
        conflict: null,
        serverBad: [],
        notice: state.applied.count > 0 ? staleNotice(state.applied.count) : updatedNotice,
      }
    case 'keep-mine':
      return { ...state, conflict: null }
    case 'restore-stash':
      if (!state.stash || state.applied.readOnly) return state
      return { ...state, buffer: state.stash, editVersion: state.editVersion + 1, stash: null, notice: null }
    case 'drop-stash':
      return { ...state, stash: null }
    case 'message':
      return { ...state, message: event.message }
  }
}

/** 新 props 到：對照上一份快照決定 buffer、dirty、提示怎麼變（順序見檔頭）。 */
function onServer(state: Local, next: ServerSnapshot): Local {
  const prev = state.applied
  if (next.key === prev.key) return state
  // 1. 比已套用的舊（refresh 回應亂序），或比最近一次成功寫入還早（寫入前就發出的重抓）：丟掉，等更新的回來。
  if (next.serverTime < prev.serverTime) return state
  if (state.sent?.serverTime && next.serverTime < state.sent.serverTime) return state

  const dirtyBefore = state.editVersion !== state.savedVersion
  const contentChanged = !sameContent(next.content, prev.content)
  const countDelta = next.count - prev.count
  const sent = state.sent
  const ownWrite =
    sent !== null && sameContent(next.content, sent.content) && (contentChanged || (sent.kind === 'submit' && countDelta > 0))

  let out: Local = { ...state, applied: next }
  if (next.savedAtText !== prev.savedAtText) out = { ...out, ack: null }

  if (ownWrite) {
    // 2. 自己這次寫入到了。
    let savedVersion = state.savedVersion
    let notice = state.notice
    if (sent.serverTime === null) {
      // 回應中斷／逾時的那一次其實已送達：以伺服器事實確認，版本沒變才算已存。
      if (sent.version === state.editVersion) savedVersion = sent.version
      notice =
        sent.kind === 'submit'
          ? { tone: 'info', text: `上一次「重新送出」其實已經送達（第 ${next.count} 次），沒有重複計分；畫面已更新。` }
          : { tone: 'info', text: '上一次「儲存草稿」其實已經存到，畫面已更新。' }
    } else if (sent.kind === 'submit' && countDelta > 1) {
      notice = { tone: 'info', text: `這一份評分也在別的分頁或裝置送出過，目前是第 ${next.count} 次。` }
    }
    const clean = state.editVersion === savedVersion
    out = { ...out, sent: null, savedVersion, notice, buffer: clean ? next.content : state.buffer, serverBad: clean ? [] : state.serverBad }
  } else if (contentChanged) {
    // 3. 別的分頁或裝置改過（或退回預填）。
    if (dirtyBefore && !next.readOnly) {
      out = { ...out, conflict: next.content, sent: null }
    } else {
      out = {
        ...out,
        buffer: dirtyBefore ? state.buffer : next.content,
        savedVersion: dirtyBefore ? state.savedVersion : state.editVersion,
        serverBad: dirtyBefore ? state.serverBad : [],
        sent: null,
        notice: countDelta > 0 ? staleNotice(next.count) : updatedNotice,
      }
    }
  } else {
    if (sent?.serverTime) out = { ...out, sent: null }
    // 5. 內容沒變、次數變了而不是自己送的。
    if (countDelta > 0) out = { ...out, notice: staleNotice(next.count) }
  }

  // 4. 變成唯讀（系辦結算）：還有未存修改就收進 stash，欄位顯示伺服器存的值。
  const dirtyAfter = out.editVersion !== out.savedVersion
  if (next.readOnly && dirtyAfter) {
    out = {
      ...out,
      stash: out.buffer,
      buffer: next.content,
      savedVersion: out.editVersion,
      conflict: null,
      serverBad: [],
      notice: { tone: 'info', text: '系辦已結算這一階段，你剛才尚未儲存的修改沒有存入；內容保留在下面，可以複製。' },
    }
  } else if (!next.readOnly && prev.readOnly && out.stash) {
    out = { ...out, notice: { tone: 'info', text: '系辦已解除結算，可以再修改；之前沒存入的內容可以按「恢復」填回表單。' } }
  }
  return out
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
  serverTime,
  eyebrow,
  members,
  children,
}: {
  assignmentId: string
  groupCode: string
  stage: SchemeStage
  /** 伺服器存的分數（暫存或採計那一筆；被退回時是退回前的）。 */
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
  /** 這份 props 在伺服器讀出的時間（ISO）：重抓回來比較舊的資料不套用。 */
  serverTime: string
  /** 頂端組別上面那一行小字（屆別・階段・方案版本）。 */
  eyebrow: string
  /** 組員姓名（一行）。 */
  members: string
  /** 放在組員下面的東西：階段切換、退回理由。 */
  children?: ReactNode
}) {
  const router = useRouter()
  // hydration 完成前按鈕還沒掛上事件，而且 React 接手 textarea 時會把已設好的選取重設到開頭（Playwright 的 fill 在那一瞬間會變成前置貼入）。
  // 掛好後在 <section> 標 data-hydrated，e2e 等到它再開始輸入；畫面上沒有任何差別。
  const hydrated = useSyncExternalStore(subscribeNothing, () => true, () => false)
  const snapshot: ServerSnapshot = {
    key: JSON.stringify([initialScores, initialComment, hasFinal, readOnly, settledAtText, draftAfterFinal, submissionHistory, savedAtText, finalScore, serverTime]),
    serverTime,
    content: normalizeContent(stage, { values: initialScores, comment: initialComment ?? '' }),
    count: submissionHistory.length,
    readOnly,
    savedAtText,
  }
  const [state, dispatch] = useReducer(reduce, snapshot, (first): Local => ({
    buffer: { values: { ...initialScores }, comment: initialComment ?? '' },
    editVersion: 0,
    savedVersion: 0,
    applied: first,
    sent: null,
    busy: null,
    ack: null,
    conflict: null,
    stash: null,
    message: null,
    notice: null,
    serverBad: [],
  }))
  // 伺服器才是事實：props 一變（router.refresh 回來）就在這一輪 render 對齊（reducer 回同一個 state 就不會再 render）。
  if (state.applied.key !== snapshot.key) dispatch({ type: 'server', snapshot })

  const { buffer, busy, conflict, stash, message, notice, serverBad } = state
  const values = buffer.values
  const comment = buffer.comment
  const dirty = state.editVersion !== state.savedVersion
  const [receipt, setReceipt] = useState<FinalReceiptView | null>(null)
  // 請求編號：內容一改就換（舊編號配新內容會被當成 REQUEST_MISMATCH）；有定論（成功、被拒）也換；中斷／逾時不換。
  const requestIds = useRef({ save: newRequestId(), submit: newRequestId() })
  const confirmDialog = useRef<HTMLDialogElement>(null)
  const receiptDialog = useRef<HTMLDialogElement>(null)
  const inputs = useRef<Record<string, HTMLElement | null>>({})

  // 回到這個分頁時重抓一次：別的分頁或裝置送出過、系辦結算了，這裡的次數、紀錄與唯讀狀態才會跟上。
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
  const showCounted = hasFinal && finalScore !== null && (readOnly || (!dirty && !draftAfterFinal))
  const shownScore = showCounted ? finalScore : formatScore(result.score)
  const submitWord = hasFinal ? '重新送出' : '正式送出'
  const percent = Math.max(0, Math.min(100, Number(shownScore) || 0))
  const savedText = state.ack?.savedAtText ?? savedAtText

  function touched() {
    // 內容變了就是新的一次儲存／送出：換新的請求編號。
    requestIds.current = { save: newRequestId(), submit: newRequestId() }
  }

  function set(key: string, value: string) {
    dispatch({ type: 'edit', key, value })
    touched()
  }

  function focusFirstMissing() {
    const item = stage.items.find((i) => !values[i.key] || errors.has(i.key))
    if (item) inputs.current[item.key]?.focus()
  }

  /** 等伺服器回應，最多 `RESPONSE_TIMEOUT_MS`；逾時回 'timeout'，之後才回來的結果不用（再按一次會接到同一張回執）。 */
  function withTimeout<T>(promise: Promise<BenchOutcome<T>>): Promise<BenchOutcome<T> | 'timeout'> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve('timeout'), RESPONSE_TIMEOUT_MS)
      promise.then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (error: unknown) => {
          clearTimeout(timer)
          reject(error instanceof Error ? error : new Error(String(error)))
        },
      )
    })
  }

  function interrupted(kind: 'save' | 'submit') {
    dispatch({
      type: 'sent-interrupted',
      text: kind === 'save' ? '連線中斷，草稿可能沒有存到；請再按一次「儲存草稿」。' : `連線中斷，不確定有沒有送到；請再按一次「${submitWord}」，不會重複計分。`,
    })
    // 重抓：如果其實已經送到，伺服器事實會對上這一次送出的內容（上面的 server 事件）。
    router.refresh()
  }

  function rejected(kind: 'save' | 'submit', outcome: { message: string; fields?: readonly string[] }) {
    requestIds.current[kind] = newRequestId()
    dispatch({ type: 'sent-rejected', text: outcome.message, fields: outcome.fields ?? [] })
    // 被拒（已結算、被退回、指派失效、版本衝突…）：重抓伺服器的事實，server 事件會把畫面對齊。
    router.refresh()
  }

  async function onSave() {
    if (errors.size > 0 || commentError) {
      dispatch({ type: 'message', message: { tone: 'error', text: `${errors.size > 0 ? [...errors.values()][0] : commentError}，修正後才能儲存草稿。` } })
      return
    }
    const version = state.editVersion
    const content = buffer
    dispatch({ type: 'sending', kind: 'save', content: normalizeContent(stage, content) })
    try {
      const outcome = await withTimeout(saveGradingDraftAction(assignmentId, content.values, content.comment, requestIds.current.save))
      if (outcome === 'timeout') return interrupted('save')
      if (!outcome.ok) return rejected('save', outcome)
      requestIds.current.save = newRequestId()
      dispatch({
        type: 'sent-ok',
        kind: 'save',
        version,
        serverTime: outcome.data.serverTime,
        savedAtText: outcome.data.savedAtText,
        text: hasFinal ? SAVED_AFTER_FINAL_NOTE : SAVED_NOTE,
        textIfEdited: SAVED_BUT_EDITED_NOTE,
      })
      // 頁首自己的狀態 Pill（`my-status`）與這張卡的草稿狀態都是伺服器事實：重抓一次（N-154）。
      router.refresh()
    } catch {
      interrupted('save')
    }
  }

  async function onSubmit() {
    confirmDialog.current?.close()
    const version = state.editVersion
    const content = buffer
    dispatch({ type: 'sending', kind: 'submit', content: normalizeContent(stage, content) })
    try {
      const outcome = await withTimeout(submitGradingAction(assignmentId, content.values, content.comment, requestIds.current.submit))
      if (outcome === 'timeout') return interrupted('submit')
      if (!outcome.ok) return rejected('submit', outcome)
      requestIds.current.submit = newRequestId()
      setReceipt(outcome.data)
      dispatch({
        type: 'sent-ok',
        kind: 'submit',
        version,
        serverTime: outcome.data.serverTime,
        savedAtText: null,
        text: null,
        textIfEdited: SUBMITTED_BUT_EDITED_NOTE,
      })
      receiptDialog.current?.showModal()
      // 次數、紀錄、採計分數都是伺服器事實：重抓，不在本地追加（同編號重試會回同一張回執，不會多一筆）。
      router.refresh()
    } catch {
      interrupted('submit')
    }
  }

  async function copyStash() {
    if (!stash) return
    try {
      await navigator.clipboard.writeText(stashLines(stage, stash, snapshot.content).join('\n'))
      dispatch({ type: 'message', message: { tone: 'ok', text: '已複製尚未儲存的內容。' } })
    } catch {
      dispatch({ type: 'message', message: { tone: 'error', text: '無法自動複製，請直接選取上面的文字。' } })
    }
  }

  const last = submissionHistory.at(-1)
  // 送出前：save-status 是頂端一列的小字；送出後：save-status 是頂部的綠色橫條，草稿狀態另外在頂端一列。
  const finalStatus = `已正式送出（第 ${last?.no ?? submissionHistory.length} 次）${last ? `・${last.atText}` : ''}${readOnly ? '' : '，可再修改後重新送出'}`
  const draftStatus =
    busy === 'save'
      ? '儲存中…'
      : dirty
        ? '有尚未儲存的修改'
        : hasFinal
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
    <section aria-label={`${groupCode}「${stage.name}」評分表`} className="dash-card" data-server-time={serverTime} data-hydrated={hydrated ? '' : undefined}>
      {/* 送出後：頂部一條綠色「已正式送出（第 n 次）・{時間}」（就是 save-status 本身） */}
      {hasFinal ? (
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
      <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-card px-5 py-3', hasFinal ? null : 'rounded-t-[18px]')}>
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
          {/* 伺服器事實：正式送出後存過草稿、還沒重新送出（和本地「有尚未儲存的修改」可以同時成立）。 */}
          {hasFinal && !readOnly && draftAfterFinal ? (
            <Pill tone="brand" testId="draft-after-final">
              有尚未送出的修改
            </Pill>
          ) : null}
          {draftStatus ? (
            <p
              role="status"
              aria-live="polite"
              data-testid={hasFinal ? 'edit-status' : 'save-status'}
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
      {conflict ? (
        <div role="status" data-testid="bench-conflict" className="mx-5 mt-3 flex flex-col gap-2 rounded-lg bg-primary-subtle px-3 py-2 text-sm text-primary-on-subtle">
          <p>
            別的分頁或裝置更新了這一份評分{hasFinal ? `（已送出到第 ${submissionHistory.length} 次）` : ''}，你這裡還有尚未儲存的修改。
            要改用伺服器的內容，還是保留你的修改？
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={cn(OUTLINE_BUTTON, 'h-9 px-3')} onClick={() => dispatch({ type: 'use-server' })}>
              改用伺服器的內容
            </button>
            <button type="button" className={cn(GHOST_BUTTON, 'h-9 px-3')} onClick={() => dispatch({ type: 'keep-mine' })}>
              保留我的修改
            </button>
          </div>
        </div>
      ) : null}
      {stash ? (
        <div role="status" data-testid="bench-stash" className="mx-5 mt-3 flex flex-col gap-2 rounded-lg bg-warning-subtle px-3 py-2 text-sm text-foreground">
          <p className="font-semibold">尚未儲存的修改（沒有存入）</p>
          <ul className="tabular flex flex-col gap-0.5 text-sm">
            {stashLines(stage, stash, snapshot.content).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            {readOnly ? (
              <button type="button" className={cn(OUTLINE_BUTTON, 'h-9 px-3')} onClick={copyStash}>
                <IconCopy className="size-3.5" aria-hidden /> 複製未儲存的內容
              </button>
            ) : (
              <button type="button" className={cn(OUTLINE_BUTTON, 'h-9 px-3')} onClick={() => dispatch({ type: 'restore-stash' })}>
                恢復未儲存的內容
              </button>
            )}
            <button type="button" className={cn(GHOST_BUTTON, 'h-9 px-3')} onClick={() => dispatch({ type: 'drop-stash' })}>
              不用了
            </button>
          </div>
        </div>
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
            dispatch({ type: 'edit-comment', value: e.target.value })
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
      {submissionHistory.length > 0 ? (
        <details data-testid="submit-history" className="border-t border-border px-5 py-3 text-sm">
          <summary className="cursor-pointer font-semibold text-foreground">送出紀錄（{submissionHistory.length} 次）</summary>
          <ol className="mt-2 flex flex-col gap-1">
            {submissionHistory.map((h) => (
              <li key={h.no} className="tabular text-muted-foreground">
                第 {h.no} 次送出・{h.atText}
                {hasFinal && h.no === submissionHistory.length ? '（目前採計）' : ''}
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
            {hasFinal && !showCounted && finalScore !== null ? <span className="ml-2 text-xs text-muted-foreground">（目前計入 {finalScore}）</span> : null}
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
        {notice ? (
          <p role="status" data-testid="bench-stale" className="mx-5 mt-3 rounded-lg bg-primary-subtle px-3 py-2 text-sm text-primary-on-subtle">
            {notice.text}
          </p>
        ) : null}
        {message ? (
          <p
            role={message.tone === 'error' ? 'alert' : 'status'}
            data-testid="bench-message"
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
                data-testid={hasFinal ? 'resubmit' : undefined}
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
            這一份分數是 <b className="tabular text-foreground">{formatScore(result.score)}</b>。{hasFinal ? RESUBMIT_NOTE : CONFIRM_NOTE}
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

/** 提示區列出沒存入的內容：只列跟伺服器存的不一樣的項目與評語。 */
function stashLines(stage: SchemeStage, stash: Content, server: Content): string[] {
  const lines: string[] = []
  for (const item of stage.items) {
    const mine = (stash.values[item.key] ?? '').trim()
    const theirs = server.values[item.key] ?? ''
    const parsed = mine === '' ? null : parseItemScore(item, mine)
    if (mine === theirs || (parsed?.ok && parsed.value === theirs)) continue
    const label = item.type === 'passfail' ? (PASS_FAIL_OPTIONS.find((o) => o.value === mine)?.label ?? mine) : mine
    lines.push(`${item.name}：${label || '（未填）'}（已存 ${theirs || '未填'}）`)
  }
  if (stash.comment.trim() !== server.comment.trim()) lines.push(`評語：${stash.comment.trim() === '' ? '（空白）' : stash.comment}`)
  return lines
}
