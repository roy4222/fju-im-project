'use client'
import { Suspense, use, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { IconAlertCircle, IconCheck, IconCopy, IconDeviceFloppy, IconRefresh, IconSend } from '@tabler/icons-react'
import { saveGradingDraftAction, submitGradingAction } from './actions'
import { COMMENT_MAX, commentLength, type BenchSnapshot } from '@/app/dashboard/teacher/grading/[groupId]/bench-types'
import type { FinalReceiptView } from '@/app/dashboard/teacher/grading/types'
import { DIALOG, GHOST_BUTTON, OUTLINE_BUTTON, Pill, PRIMARY_BUTTON, StampMark } from '@/app/dashboard/teacher/_ui/dash'
import type * as Scoring from '@/app/dashboard/teacher/grading/[groupId]/bench-scoring'
import type { SchemeStage } from '@/application/grading'
import { cn } from '@/shared/cn'

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
 * - 同一次送出（連點、斷線重試）帶同一個請求編號，伺服器只算一次。
 *
 * ## 狀態模型（Review #584 第 1～5 輪）：四條不變條件＋三條簡化規則
 *
 * 前四輪每多一種「客戶端推論伺服器發生了什麼」就多一組反例；第 5 輪把推論路徑全部拿掉，只留事實與人來選。
 *
 * 不變條件：
 * 1. **資料庫的寫入版本是唯一排序鍵**（`snapshot.version`，`page.tsx` 從該指派每筆寫入的戳記算；收據的 `version` 同一把尺）。
 *    重抓回來的快照比已接受／已知的版本舊 → 整包丟掉；同版本但評分軸事實不同 → 不覆寫、提示重新整理；
 *    同版本、評分軸相同、只差顯示軸 → 讀出時間嚴格較新才接受。畫面只讀「最後接受」的快照（`state.applied`），不直接讀 props。
 * 2. **`{requestId, payload}` 不可變**（`pending`）：按下時把欄位原值凍結成 payload，重送原樣送出，不重讀欄位、不正規化。
 * 3. **收據只在「收據版本 ≥ 目前已知最新版本」時確認**；比已知的舊＝這次送的內容已被之後的寫入取代 → 不當作已存、出衝突區讓老師選，不開收件章。
 * 4. **未存內容保存成列表**（`stashes`）、只能複製或按「不用了」丟棄指定那筆（不自動恢復進欄位）；**render 裡零 dispatch**——新快照在 effect 處理，用「已處理的 key」ref 去重。
 *
 * 簡化規則：
 * - **S1 送達只靠收據**：有沒有送到只看該請求編號的收據。回應中斷／逾時 → `pending` 進入 `interrupted`（上一次結果不明），
 *   動作列只剩「再送一次」：以原 `{requestId, payload}` 重送，伺服器冪等回同一張收據（已送達）或寫入（沒送達）。
 *   重抓回來的快照**不**拿來判定送達（內容相同也不算）。
 * - **S2 未存用內容比對**：`confirmed` 是最後一次伺服器確認的內容（收據 → 那次 payload；被接受的快照 → 快照內容），
 *   未存 ＝ 正規化後的 `buffer` 跟 `confirmed` 不同；「等待期間有沒有續改」＝回應到時比 `buffer` 與該次 payload。沒有編輯計數。
 * - **S3 結算單向鎖**：一旦接受過唯讀（已結算）的快照，就維持唯讀＋Pill＋stash 直到整頁重新載入；之後的快照只更新內容與次數，不解鎖。
 *   解除結算後老師按唯讀區的「重新整理」。被拒回應（例如 CONFLICT 已結算）走重抓 → 快照上鎖，不另外判訊息字串。
 * - 其餘對不上的情況一律提示、請老師選或重新整理，不自動合併。
 */

/** 結算後的說明（設計方案 §2.5）。 */
const SETTLED_NOTE = '這個階段成績已由系辦結算，如需修改請聯絡系辦。'
/** S3：解除結算後要整頁重載才會解鎖。 */
const RELOAD_NOTE = '若系辦已解除結算，請重新整理頁面後再修改。'
/** 重新送出的確認說明。 */
const RESUBMIT_NOTE = '送出後以這一次為準，上一次送出的分數改列為歷史紀錄。'
/** 正式送出後再儲存草稿的訊息。 */
const SAVED_AFTER_FINAL_NOTE = '已儲存草稿。計入成績的仍是上一次送出的分數，按「重新送出」才會更新。'
/** 回應還沒回來前又改了內容：存到的是按下時的內容。 */
const SAVED_BUT_EDITED_NOTE = '已儲存你按下「儲存草稿」時的內容；之後改的還沒存，請再按一次「儲存草稿」。'
const SUBMITTED_BUT_EDITED_NOTE = '已送出你按下時的內容並計入成績；之後改的還沒存，可再「儲存草稿」或「重新送出」。'
/** 等伺服器回應最多這麼久；超過當成連線中斷（請求編號不換，「再送一次」會接到同一張回執）。 */
const RESPONSE_TIMEOUT_MS = 20_000

const newRequestId = () => crypto.randomUUID()
const subscribeNothing = () => () => {}

/**
 * 算分與規則（`rules.ts`＋`@/shared/score` 的 decimal.js）另一包載入（C1-12a）：`[groupId]` 路由的首載 JS 很緊（上限 250 KB），
 * 這一包不算進首載。模組一載入就開始抓；`GradingBench` 用 `use()` 等它到了才畫評分卡（伺服器一樣先畫好整張卡，
 * 瀏覽器接手前保留伺服器的畫面），所以下面的函式被呼叫時 `scoring` 一定已經有值。算式仍是伺服器同一份。
 */
let scoring: typeof Scoring
const scoringReady = import('@/app/dashboard/teacher/grading/[groupId]/bench-scoring').then((m) => {
  scoring = m
})

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

// ───────────── 本地 state：編輯中的內容 vs 已接受的伺服器快照 ─────────────

/** 一份分數＋評語。buffer 與 payload 放欄位原值；比對用 `normalizeContent` 後的形狀。 */
type Content = { readonly values: Readonly<Record<string, string>>; readonly comment: string }

/** 已接受的伺服器快照：props 的 `BenchSnapshot` 加上比對用的正規化內容與兩把 key。 */
type Applied = BenchSnapshot & {
  /** 伺服器存的分數與評語（正規化後，和 `normalizeContent` 同一種形狀）。 */
  readonly content: Content
  /** 正式送出的次數。 */
  readonly count: number
  /** 評分軸事實：版本、內容、次數、儲存時間、草稿狀態、是否採計。同版本時這些必須一致。 */
  readonly factsKey: string
  /** 全部事實（含 serverTime、唯讀、結算時間、採計分數…）：一字不差就是同一份。 */
  readonly fullKey: string
}

/**
 * 一次儲存／送出的操作：按下那一刻凍結的 `{requestId, payload}`，「再送一次」原樣送、不重讀欄位。
 * `inflight` 等回應；`interrupted` 回應中斷或逾時（結果不明，只能再送一次）。收據（確認或被拒）一到就結束、`pending` 清空。
 */
type PendingOp = {
  readonly kind: 'save' | 'submit'
  readonly requestId: string
  /** 送出的欄位原值。 */
  readonly payload: Content
  readonly phase: 'inflight' | 'interrupted'
}

/** 轉唯讀時沒存進去的一份內容（只能複製；S3 之後要整頁重載才能再編輯，重載後本地 state 就沒了）。 */
type StashEntry = {
  readonly id: number
  readonly settledAtText: string | null
  readonly content: Content
  /** 收進來時伺服器存的內容（正規化）：提示區只列跟它不一樣的項目。 */
  readonly server: Content
}

type Message = { readonly tone: 'ok' | 'info' | 'error'; readonly text: string }

type Local = {
  readonly buffer: Content
  /** S2：最後一次伺服器確認的內容（正規化）——收據確認的那次 payload，或最後接受的快照內容。未存＝`buffer` 正規化後跟它不同。 */
  readonly confirmed: Content
  readonly applied: Applied
  /** 已知的伺服器最新版本：已接受快照與已確認收據的最大值；比它舊的快照、收據都不算。 */
  readonly knownVersion: string
  readonly pending: PendingOp | null
  readonly busy: 'save' | 'submit' | null
  /** 儲存成功的回執先顯示在狀態列，props 的儲存時間跟上就不用了。 */
  readonly ack: { readonly savedAtText: string } | null
  /** 伺服器的新內容（別的分頁或裝置改的）與本地未存修改衝突，等老師選。 */
  readonly conflict: Content | null
  readonly stashes: readonly StashEntry[]
  readonly nextStashId: number
  /** 這次動作的結果（成功、被拒、中斷、舊收據）。 */
  readonly message: Message | null
  /** 同步類提示（別處送出過、已結算、資料對不上…）。 */
  readonly notice: Message | null
  /** 伺服器指出有問題的項目。 */
  readonly serverBad: readonly string[]
}

type Event =
  | { type: 'edit'; key: string; value: string }
  | { type: 'edit-comment'; value: string }
  | { type: 'sending'; op: PendingOp }
  | { type: 'sent-ok'; requestId: string; version: string; savedAtText: string | null; text: string | null; textIfEdited: string }
  | { type: 'sent-rejected'; text: string; fields: readonly string[] }
  | { type: 'sent-interrupted'; text: string }
  | { type: 'server'; snapshot: Applied }
  | { type: 'use-server' }
  | { type: 'keep-mine' }
  | { type: 'drop-stash'; id: number }
  | { type: 'message'; message: Message | null }

/** 跟伺服器同一套正規化（數字去尾零、空白項拿掉、只有空白的評語當沒有），兩邊才比得出「一樣」。 */
function normalizeContent(stage: SchemeStage, content: Content): Content {
  const values: Record<string, string> = {}
  for (const item of stage.items) {
    const raw = (content.values[item.key] ?? '').trim()
    if (raw === '') continue
    const parsed = scoring.parseItemScore(item, raw)
    values[item.key] = parsed.ok ? parsed.value : raw
  }
  return { values, comment: content.comment.trim() === '' ? '' : content.comment }
}

const contentKey = (c: Content) => JSON.stringify([c.values, c.comment])
const sameContent = (a: Content, b: Content) => contentKey(a) === contentKey(b)
const laterOf = (a: string, b: string) => (a > b ? a : b)

/** props 的快照 → 可比對的 `Applied`。 */
function toApplied(stage: SchemeStage, s: BenchSnapshot): Applied {
  const content = normalizeContent(stage, { values: s.scores, comment: s.comment ?? '' })
  const count = s.submissionHistory.length
  const factsKey = JSON.stringify([s.version, content.values, content.comment, count, s.savedAtText, s.draftAfterFinal, s.hasFinal])
  const fullKey = JSON.stringify([factsKey, s.serverTime, s.readOnly, s.settledAtText, s.finalScore, s.draftFromOlderVersion, s.submissionHistory])
  return { ...s, content, count, factsKey, fullKey }
}

/** 次數變多的提示：只說伺服器上的事實，不說是誰送的。 */
const countNotice = (count: number): Message => ({ tone: 'info', text: `伺服器上這一份評分已送出到第 ${count} 次，畫面已更新為最新狀態。` })
const updatedNotice: Message = { tone: 'info', text: '這一份評分在別的地方有更新，畫面已更新為最新狀態。' }
const unresolvedNotice: Message = { tone: 'error', text: '伺服器回傳的資料跟畫面對不上，請重新整理頁面。' }
const settledNotice: Message = { tone: 'info', text: '系辦已結算這一階段，你剛才尚未儲存的修改沒有存入；內容保留在下面，可以複製。' }
/** 舊收據的訊息；`dirty`：欄位跟伺服器確認的內容不同（沒有未存就不說「仍未儲存」）。 */
const staleReceiptNote = (kind: 'save' | 'submit', count: number, dirty: boolean): Message => ({
  tone: 'error',
  text:
    kind === 'submit'
      ? `這一次「重新送出」的內容在送出後已被別的分頁或裝置的送出取代（目前是第 ${count} 次，計入成績的是伺服器上的內容）；${
          dirty ? '你這裡的修改仍未送出，可改用伺服器的內容，或再按一次「重新送出」。' : '畫面已是伺服器上的內容，沒有尚未儲存的修改。'
        }`
      : `這一次「儲存草稿」的內容之後已被別的分頁或裝置更新；${
          dirty ? '你這裡的修改仍未儲存，可改用伺服器的內容，或再按一次「儲存草稿」。' : '畫面已是伺服器上的內容，沒有尚未儲存的修改。'
        }`,
})

function reduce(stage: SchemeStage, state: Local, event: Event): Local {
  const dirty = () => !sameContent(normalizeContent(stage, state.buffer), state.confirmed)
  switch (event.type) {
    case 'edit':
      return {
        ...state,
        buffer: { ...state.buffer, values: { ...state.buffer.values, [event.key]: event.value } },
        serverBad: state.serverBad.filter((k) => k !== event.key),
      }
    case 'edit-comment':
      return { ...state, buffer: { ...state.buffer, comment: event.value } }
    case 'sending':
      return { ...state, busy: event.op.kind, message: null, pending: event.op }
    case 'sent-ok': {
      const op = state.pending
      if (!op || op.requestId !== event.requestId) return { ...state, busy: null }
      if (event.version < laterOf(state.knownVersion, state.applied.version)) {
        // 不變條件 3：舊收據——這次送的內容在那之後已被更新的寫入取代。不當作已存；有未存就出衝突區讓老師選，
        // 沒有未存（欄位已跟伺服器確認的內容相同）就沒有要選的，衝突區收起。
        const unsaved = dirty()
        return { ...state, busy: null, pending: null, message: staleReceiptNote(op.kind, state.applied.count, unsaved), conflict: unsaved ? state.applied.content : null }
      }
      // S1＋S2：收據確認的是凍結的 payload；等待期間有沒有續改＝現在的欄位跟 payload 比。
      const confirmed = normalizeContent(stage, op.payload)
      const edited = !sameContent(normalizeContent(stage, state.buffer), confirmed)
      return {
        ...state,
        busy: null,
        pending: null,
        confirmed,
        // 收據確認了這一次，之前（中斷期間別處更新而出現）的衝突區就不再成立。
        conflict: null,
        knownVersion: laterOf(state.knownVersion, event.version),
        ack: event.savedAtText ? { savedAtText: event.savedAtText } : state.ack,
        message: edited ? { tone: 'info', text: event.textIfEdited } : event.text ? { tone: 'ok', text: event.text } : null,
        serverBad: [],
      }
    }
    case 'sent-rejected':
      return { ...state, busy: null, pending: null, message: { tone: 'error', text: event.text }, serverBad: event.fields }
    case 'sent-interrupted':
      // S1：結果不明。`pending` 留著（interrupted），動作列只剩「再送一次」。
      return { ...state, busy: null, pending: state.pending ? { ...state.pending, phase: 'interrupted' } : null, message: { tone: 'error', text: event.text } }
    case 'server':
      return onServer(stage, state, event.snapshot)
    case 'use-server':
      // 改用伺服器的內容＝放棄原本那一次操作（還在路上的除外，它的回應會自己判）。
      return {
        ...state,
        buffer: state.applied.content,
        conflict: null,
        serverBad: [],
        pending: state.pending?.phase === 'inflight' ? state.pending : null,
        notice: updatedNotice,
      }
    case 'keep-mine':
      return { ...state, conflict: null }
    case 'drop-stash':
      return { ...state, stashes: state.stashes.filter((s) => s.id !== event.id) }
    case 'message':
      return { ...state, message: event.message }
  }
}

/**
 * 新快照到：先照不變條件 1 決定收不收，收了再對照 `confirmed` 決定 buffer、衝突、提示怎麼變，最後套 S3 的單向鎖。
 * 拒絕時回同一個 state（React 不重繪）。
 */
function onServer(stage: SchemeStage, state: Local, next: Applied): Local {
  const prev = state.applied
  if (next.fullKey === prev.fullKey) return state
  // 1a. 比已接受／已知的寫入版本舊（重抓亂序、寫入前就發出的重抓）：整包丟掉。
  if (next.version < laterOf(state.knownVersion, prev.version)) return state
  if (next.version === prev.version) {
    // 1b. 同版本：評分軸事實必須一致，不一致就是壞掉或偽造的快照 → 不覆寫，提示重新整理。
    if (next.factsKey !== prev.factsKey) return state.notice === unresolvedNotice ? state : { ...state, notice: unresolvedNotice }
    // 1c. 只差顯示軸（採計分數重算、規則版本提示…）：讀出時間嚴格較新才接受。結算不靠這裡，見 S3。
    if (next.serverTime <= prev.serverTime) return state
  }
  // S3：看過唯讀就維持到整頁重載；之後的快照只更新內容與次數，不解鎖、Pill 不消失。
  const applied: Applied = prev.readOnly && !next.readOnly ? { ...next, readOnly: true, settledAtText: next.settledAtText ?? prev.settledAtText } : next
  const mine = normalizeContent(stage, state.buffer)
  const localDirty = !sameContent(mine, state.confirmed)
  const serverMoved = !sameContent(next.content, state.confirmed)
  const countDelta = next.count - prev.count
  // 次數變多就提示；唯一不提示的是收據已告知的那一次送出（版本等於已知、恰好多 1）。
  const counted = countDelta > 0 && !(countDelta === 1 && next.version === state.knownVersion) ? countNotice(next.count) : null

  let out: Local = {
    ...state,
    applied,
    confirmed: next.content,
    knownVersion: laterOf(state.knownVersion, next.version),
    ack: next.savedAtText !== prev.savedAtText ? null : state.ack,
  }
  if (serverMoved && !localDirty) {
    // 本地沒改、伺服器變了（別的分頁或裝置改過、退回預填）：跟上。
    out = { ...out, buffer: next.content, serverBad: [], notice: counted ?? updatedNotice }
  } else if (serverMoved && !sameContent(mine, next.content) && !applied.readOnly) {
    // 本地有未存、伺服器也變了、兩邊不同：衝突區讓老師選。中斷的操作留著，由它的收據判。
    out = { ...out, conflict: next.content, notice: counted ?? state.notice }
  } else if (counted) {
    out = { ...out, notice: counted }
  }
  if (!applied.readOnly) return out

  // S3＋不變條件 4：唯讀（系辦結算）時還有未存修改 → 收成一筆 stash，欄位顯示伺服器存的值；之後的操作作廢。
  if (sameContent(normalizeContent(stage, out.buffer), next.content)) return { ...out, conflict: null, pending: null }
  const entry: StashEntry = { id: out.nextStashId, settledAtText: applied.settledAtText, content: out.buffer, server: next.content }
  return {
    ...out,
    stashes: [...out.stashes, entry],
    nextStashId: out.nextStashId + 1,
    buffer: next.content,
    conflict: null,
    serverBad: [],
    pending: null,
    notice: settledNotice,
  }
}

type BenchProps = {
  assignmentId: string
  groupCode: string
  stage: SchemeStage
  /** 這次 render 伺服器給的事實；是否接受由不變條件 1 決定（見檔頭），畫面只讀接受的那一份。 */
  snapshot: BenchSnapshot
  /** 頂端組別上面那一行小字（屆別・階段・方案版本）。 */
  eyebrow: string
  /** 組員姓名（一行）。 */
  members: string
  /** 放在組員下面的東西：階段切換、退回理由。 */
  children?: ReactNode
}

/** 評分卡：等算分那一包到了才畫（見 `scoringReady`）；只有評分卡這一格等，頁面其他部分照常接手。 */
export function GradingBench(props: BenchProps) {
  return (
    <Suspense>
      <Bench {...props} />
    </Suspense>
  )
}

function Bench({ assignmentId, groupCode, stage, snapshot, eyebrow, members, children }: BenchProps) {
  use(scoringReady)
  const router = useRouter()
  // hydration 完成前按鈕還沒掛上事件，而且 React 接手 textarea 時會把已設好的選取重設到開頭（Playwright 的 fill 在那一瞬間會變成前置貼入）。
  // 掛好後在 <section> 標 data-hydrated，e2e 等到它再開始輸入；畫面上沒有任何差別。
  const hydrated = useSyncExternalStore(subscribeNothing, () => true, () => false)
  const incoming = useMemo(() => toApplied(stage, snapshot), [stage, snapshot])
  const [state, dispatch] = useReducer((current: Local, event: Event) => reduce(stage, current, event), incoming, (first): Local => ({
    buffer: { values: { ...first.scores }, comment: first.comment ?? '' },
    confirmed: first.content,
    applied: first,
    knownVersion: first.version,
    pending: null,
    busy: null,
    ack: null,
    conflict: null,
    stashes: [],
    nextStashId: 1,
    message: null,
    notice: null,
    serverBad: [],
  }))
  // 事件處理函式要看「現在」的 state（await 期間可能已有新快照），不用按下那一刻的 closure；每次 render 後更新。
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  })

  // 不變條件 4：新快照在 effect 處理、一份只 dispatch 一次（reducer 拒絕也不會再送），render 裡零 dispatch。
  const handledKey = useRef(incoming.fullKey)
  useEffect(() => {
    if (handledKey.current === incoming.fullKey) return
    handledKey.current = incoming.fullKey
    dispatch({ type: 'server', snapshot: incoming })
  }, [incoming])

  const applied = state.applied
  const { hasFinal, readOnly, settledAtText, draftAfterFinal, submissionHistory, savedAtText, finalScore, draftFromOlderVersion } = applied
  const { buffer, busy, conflict, stashes, message, notice, serverBad, pending } = state
  const values = buffer.values
  const comment = buffer.comment
  // S2：未存＝正規化後的欄位內容跟最後一次伺服器確認的不同。
  const dirty = !sameContent(normalizeContent(stage, buffer), state.confirmed)
  const interrupted = pending?.phase === 'interrupted' ? pending : null
  const [receipt, setReceipt] = useState<FinalReceiptView | null>(null)
  // 連點在同一次 render 內兩次進來（React 還沒把 disabled 畫出來）：第二次直接略過，不會開第二個操作。
  const busyRef = useRef(false)
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

  const result = scoring.teacherStageScore(stage.items, stage.letterMap, values)
  const errors = scoring.itemErrors(stage.items, values)
  const missing = scoring.missingCount(stage.items, values)
  const commentError = commentLength(comment) > COMMENT_MAX ? `評語最多 ${COMMENT_MAX} 字` : null
  const complete = missing === 0 && errors.size === 0 && commentError === null
  // 沒有改過（或唯讀）時顯示計入成績的分數；正式送出後又改了，顯示新分數的預覽。
  const showCounted = hasFinal && finalScore !== null && (readOnly || (!dirty && !draftAfterFinal))
  const shownScore = showCounted ? finalScore : scoring.formatScore(result.score)
  // C1-12（設計方案① §7.3）：按鈕「送出」，送出過是「重新送出」。
  const submitWord = hasFinal ? '重新送出' : '送出'
  const percent = Math.max(0, Math.min(100, Number(shownScore) || 0))
  const savedText = state.ack?.savedAtText ?? savedAtText

  function set(key: string, value: string) {
    dispatch({ type: 'edit', key, value })
  }

  function focusFirstMissing() {
    const item = stage.items.find((i) => !values[i.key] || errors.has(i.key))
    if (item) inputs.current[item.key]?.focus()
  }

  /** 不變條件 2：開始新的一次操作——凍結現在的欄位原值與新的請求編號。回傳 null＝這一刻已有操作在路上（連點）。 */
  function beginOp(kind: 'save' | 'submit'): PendingOp | null {
    if (busyRef.current) return null
    busyRef.current = true
    const op: PendingOp = { kind, requestId: newRequestId(), payload: stateRef.current.buffer, phase: 'inflight' }
    dispatch({ type: 'sending', op })
    return op
  }

  /** S1：「再送一次」——結果不明的那一次原樣重送（同編號、同 payload），不重讀欄位。 */
  function beginResend(): PendingOp | null {
    const previous = stateRef.current.pending
    if (busyRef.current || !previous || previous.phase !== 'interrupted') return null
    busyRef.current = true
    const op: PendingOp = { ...previous, phase: 'inflight' }
    dispatch({ type: 'sending', op })
    return op
  }

  /** 等伺服器回應，最多 `RESPONSE_TIMEOUT_MS`；逾時回 'timeout'，之後才回來的結果不用（「再送一次」會接到同一張回執）。 */
  function withTimeout<T>(promise: Promise<T>): Promise<T | 'timeout'> {
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

  /** 不變條件 3：收據版本比已知最新的舊 → 不確認（reducer 會出衝突區）；這裡只決定要不要開收件章。 */
  function receiptIsCurrent(version: string) {
    const current = stateRef.current
    return version >= laterOf(current.knownVersion, current.applied.version)
  }

  /** 把一次操作送到伺服器並處理回應；重抓事實交給 server 事件，不在本地推論。 */
  async function perform(op: PendingOp) {
    const { values: scores, comment: text } = op.payload
    try {
      if (op.kind === 'save') {
        const outcome = await withTimeout(saveGradingDraftAction(assignmentId, scores, text, op.requestId))
        if (outcome === 'timeout') return markInterrupted(op.kind)
        if (!outcome.ok) return rejected(outcome)
        dispatch({
          type: 'sent-ok',
          requestId: op.requestId,
          version: outcome.data.version,
          savedAtText: outcome.data.savedAtText,
          text: hasFinal ? SAVED_AFTER_FINAL_NOTE : scoring.SAVED_NOTE,
          textIfEdited: SAVED_BUT_EDITED_NOTE,
        })
      } else {
        const outcome = await withTimeout(submitGradingAction(assignmentId, scores, text, op.requestId))
        if (outcome === 'timeout') return markInterrupted(op.kind)
        if (!outcome.ok) return rejected(outcome)
        const current = receiptIsCurrent(outcome.data.version)
        dispatch({ type: 'sent-ok', requestId: op.requestId, version: outcome.data.version, savedAtText: null, text: null, textIfEdited: SUBMITTED_BUT_EDITED_NOTE })
        // 舊收據（這次送的內容已被之後的送出取代）不開收件章：reducer 已出衝突區說明。
        if (current) {
          setReceipt(outcome.data)
          receiptDialog.current?.showModal()
        }
      }
      // 次數、紀錄、採計分數、頁首 Pill 都是伺服器事實：重抓，不在本地追加。
      router.refresh()
    } catch {
      markInterrupted(op.kind)
    } finally {
      busyRef.current = false
    }
  }

  function markInterrupted(kind: 'save' | 'submit') {
    dispatch({
      type: 'sent-interrupted',
      text: kind === 'save' ? '連線中斷，不確定草稿有沒有存到；請按「再送一次」。' : '連線中斷，不確定有沒有送到；請按「再送一次」，同一個請求不會重複計分。',
    })
    // 重抓伺服器事實（次數、唯讀）；有沒有送到仍只看收據。
    router.refresh()
  }

  function rejected(outcome: { message: string; fields?: readonly string[] }) {
    dispatch({ type: 'sent-rejected', text: outcome.message, fields: outcome.fields ?? [] })
    // 被拒（已結算、被退回、指派失效、版本衝突…）：重抓伺服器的事實，server 事件會把畫面對齊（已結算就上鎖）。
    router.refresh()
  }

  function onSave() {
    if (errors.size > 0 || commentError) {
      dispatch({ type: 'message', message: { tone: 'error', text: `${errors.size > 0 ? [...errors.values()][0] : commentError}，修正後才能儲存草稿。` } })
      return
    }
    const op = beginOp('save')
    if (op) void perform(op)
  }

  function onSubmit() {
    confirmDialog.current?.close()
    const op = beginOp('submit')
    if (op) void perform(op)
  }

  function onResend() {
    const op = beginResend()
    if (op) void perform(op)
  }

  async function copyStash(entry: StashEntry) {
    try {
      await navigator.clipboard.writeText(stashLines(stage, entry.content, entry.server).join('\n'))
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
    : interrupted
      ? `上一次「${interrupted.kind === 'save' ? '儲存草稿' : submitWord}」結果不明：「再送一次」會用同一個請求編號重送，不會重複計分。`
      : errors.size === 0 && missing === 0 && commentError
        ? `${commentError}，刪短後才能${submitWord}。`
        : scoring.blockReason(errors, missing).replace('正式送出', submitWord)

  return (
    <section
      aria-label={`${groupCode}「${stage.name}」評分表`}
      className="dash-card"
      data-server-time={applied.serverTime}
      data-version={applied.version}
      data-hydrated={hydrated ? '' : undefined}
    >
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
      {readOnly ? (
        <div data-testid="settled-notice" className="tabular mx-5 mt-3 flex flex-col gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
          <p>
            {settledAtText ? `${SETTLED_NOTE}（結算時間 ${settledAtText}）` : '已正式送出，分數已計入階段成績。'} {RELOAD_NOTE}
          </p>
          <button type="button" className={cn(OUTLINE_BUTTON, 'h-9 w-fit px-3')} onClick={() => window.location.reload()}>
            <IconRefresh className="size-3.5" aria-hidden /> 重新整理
          </button>
        </div>
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
      {stashes.length > 0 ? (
        <div role="status" data-testid="bench-stash" className="mx-5 mt-3 flex flex-col gap-3 rounded-lg bg-warning-subtle px-3 py-2 text-sm text-foreground">
          <p className="font-semibold">尚未儲存的修改（沒有存入）{stashes.length > 1 ? `・${stashes.length} 份` : ''}</p>
          {stashes.map((entry) => (
            <div key={entry.id} data-testid="bench-stash-entry" className="flex flex-col gap-2">
              <p className="tabular text-xs text-muted-foreground">
                {entry.settledAtText ? `結算（${entry.settledAtText}）時` : '轉成唯讀時'}沒存入的內容；重新整理頁面後這裡就不會再顯示，請先複製。
              </p>
              <ul className="tabular flex flex-col gap-0.5 text-sm">
                {stashLines(stage, entry.content, entry.server).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={cn(OUTLINE_BUTTON, 'h-9 px-3')} onClick={() => copyStash(entry)}>
                  <IconCopy className="size-3.5" aria-hidden /> 複製未儲存的內容
                </button>
                <button type="button" className={cn(GHOST_BUTTON, 'h-9 px-3')} onClick={() => dispatch({ type: 'drop-stash', id: entry.id })}>
                  不用了
                </button>
              </div>
            </div>
          ))}
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
                    {scoring.LETTER_GRADES.map((g) => (
                      <option key={g} value={g}>
                        {g}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div role="radiogroup" aria-labelledby={`${id}-name`} id={id} className="inline-flex w-full max-w-60 gap-1 rounded-lg bg-muted p-1">
                    {scoring.PASS_FAIL_OPTIONS.map((option, optionIndex) => (
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
          onChange={(e) => dispatch({ type: 'edit-comment', value: e.target.value })}
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
              {errors.size > 0 ? `${errors.size} 項需修正` : scoring.missingText(missing)}
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
          {readOnly ? null : interrupted ? (
            // S1：上一次結果不明，只能原樣再送一次（同編號、同 payload）；收據到了才會回到一般動作。
            <div className="flex w-full flex-col items-stretch gap-1 sm:w-auto sm:items-end">
              <button type="button" data-testid="resend" className={cn(PRIMARY_BUTTON, 'w-full px-4 sm:w-auto')} onClick={onResend} disabled={busy !== null}>
                <IconSend /> {busy ? '送出中…' : '再送一次'}
              </button>
              <span data-testid="resend-note" className="text-xs text-muted-foreground">
                送出的是中斷當時的內容
              </span>
            </div>
          ) : (
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
          )}
        </div>
      </div>

      <dialog ref={confirmDialog} aria-label={`確認${submitWord}`} className={cn(DIALOG, 'w-[min(24rem,calc(100vw-2rem))]')}>
        <div className="flex flex-col gap-3 p-6">
          <h2 className="text-lg font-extrabold text-foreground">
            {submitWord} {groupCode}「{stage.name}」？
          </h2>
          <p className="text-sm text-muted-foreground">
            這一份分數是 <b className="tabular text-foreground">{scoring.formatScore(result.score)}</b>。{hasFinal ? RESUBMIT_NOTE : scoring.CONFIRM_NOTE}
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
            <p className="text-xs text-muted-foreground">{scoring.RECEIPT_NOTE}</p>
            <button type="button" className={OUTLINE_BUTTON} onClick={() => receiptDialog.current?.close()}>
              知道了
            </button>
          </div>
        ) : null}
      </dialog>
    </section>
  )
}

/** 提示區列出沒存入的內容：只列跟伺服器（收進來當時）存的不一樣的項目與評語。 */
function stashLines(stage: SchemeStage, stash: Content, server: Content): string[] {
  const lines: string[] = []
  for (const item of stage.items) {
    const mine = (stash.values[item.key] ?? '').trim()
    const theirs = server.values[item.key] ?? ''
    const parsed = mine === '' ? null : scoring.parseItemScore(item, mine)
    if (mine === theirs || (parsed?.ok && parsed.value === theirs)) continue
    const label = item.type === 'passfail' ? (scoring.PASS_FAIL_OPTIONS.find((o) => o.value === mine)?.label ?? mine) : mine
    lines.push(`${item.name}：${label || '（未填）'}（已存 ${theirs || '未填'}）`)
  }
  if (stash.comment.trim() !== server.comment.trim()) lines.push(`評語：${stash.comment.trim() === '' ? '（空白）' : stash.comment}`)
  return lines
}
