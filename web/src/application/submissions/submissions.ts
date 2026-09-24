import type { FieldType, FormField } from '@/application/items'
import { formatTaipeiMinute, formatTaipeiSecond, isDeadlinePassed } from '@/shared/time'

/**
 * 個人填報與送出的純規則（票 17；產品模組 05 §4「個人填報與收件名單」「4.6」；模組實作設計 05 §2、§3）。
 *
 * 這裡沒有資料庫也沒有框架：答案整理、送出前檢查、開放／截止判斷、作業區的狀態字，都可以單獨測。
 * 交易、鎖、帳本在 `infrastructure/submissions/pg-submissions.ts`。
 *
 * 模組 04 的欄位型別只能帶型別（跨模組 type-only，母 spec §4.3），
 * 所以「哪些欄位要填」「哪些是選項」在這裡自己列一次；和 `application/items` 的清單由單元測試對照。
 */

// ── 欄位 ────────────────────────────────────────────────────────────────────

/** 只給人看、不用填的區塊（模組 04 的 `STATIC_FIELD_TYPES`）。 */
const STATIC_TYPES: ReadonlySet<FieldType> = new Set(['heading', 'paragraph'])
const CHOICE_ONE: ReadonlySet<FieldType> = new Set(['radio', 'select'])

export function isAnswerField(field: Pick<FormField, 'type'>): boolean {
  return !STATIC_TYPES.has(field.type)
}

export function answerFields(fields: readonly FormField[]): FormField[] {
  return fields.filter(isAnswerField)
}

/**
 * 檔案欄位（票 21）：一個檔案欄位放**一個**檔，答案存的是檔案 ID（`stored_files.id`）。
 * 檔案先經上傳憑證串流上傳、驗過類型與大小變成 `stored`，存草稿時才綁到草稿上；
 * 這裡只看形狀（是不是 uuid），是不是本人或本組上傳、類型大小合不合欄位規則，由存草稿的交易在鎖內檢查。
 */
const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isFileField(field: Pick<FormField, 'type'>): boolean {
  return field.type === 'file'
}

/** 答案裡的檔案（欄位代號 → 檔案 ID），依欄位順序。 */
export function fileAnswers(fields: readonly FormField[], answers: Answers): { fieldKey: string; fileId: string }[] {
  const out: { fieldKey: string; fileId: string }[] = []
  for (const field of fields) {
    if (!isFileField(field)) continue
    const value = answers[field.key]
    if (typeof value === 'string' && FILE_ID.test(value)) out.push({ fieldKey: field.key, fileId: value })
  }
  return out
}

/** 位元組數換成 MiB 上限（欄位設定用整數 MiB）。 */
export const MIB = 1024 * 1024

/** 單行欄位最多幾個字；長文字另計。 */
export const LINE_MAX_LENGTH = 500
export const TEXTAREA_MAX_LENGTH = 10_000

// ── 答案 ────────────────────────────────────────────────────────────────────

export type AnswerValue = string | readonly string[]
export type Answers = Readonly<Record<string, AnswerValue>>

export type FieldIssue = { readonly key: string; readonly label: string; readonly message: string }

export type NormalizedAnswers = { readonly ok: true; readonly value: Answers } | { readonly ok: false; readonly issue: FieldIssue }

function issue(field: FormField, message: string): { ok: false; issue: FieldIssue } {
  return { ok: false, issue: { key: field.key, label: field.label, message } }
}

/** 單行文字：控制字元換空白、去頭尾空白。 */
function cleanLine(value: string): string {
  return [...value].map((ch) => (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f ? ' ' : ch)).join('').trim()
}

/** 長文字：保留換行，其他控制字元拿掉，統一成 `\n`。 */
function cleanText(value: string): string {
  return [...value.replaceAll('\r\n', '\n')]
    .filter((ch) => ch === '\n' || ch === '\t' || !(ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f))
    .join('')
    .trim()
}

/**
 * 存草稿用的整理（模組實作設計 05 §6：「答案以目前 schema 驗證（必填只在送出擋）」）。
 *
 * - 只留目前欄位版本裡的輸入欄位；沒填的欄位不存。
 * - 形狀要對：選項只能是欄位列出的、複選是字串陣列、長度有上限。形狀不對＝前端被竄改或頁面太舊，直接拒絕。
 * - 格式（Email、網址、數字、日期、時間）在草稿不擋：填到一半的內容也要存得住，送出時才檢查。
 * - 檔案欄位：只收一個檔案 ID（uuid）；檔案是誰的、合不合規則在存草稿的交易裡檢查。
 */
export function normalizeAnswers(fields: readonly FormField[], raw: unknown): NormalizedAnswers {
  const source = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const out: Record<string, AnswerValue> = {}
  for (const field of answerFields(fields)) {
    const value = source[field.key]
    if (value === undefined || value === null) continue
    if (isFileField(field)) {
      if (value === '') continue
      if (typeof value !== 'string' || !FILE_ID.test(value.toLowerCase())) {
        return issue(field, `「${field.label}」的檔案資料不對，請重新上傳。`)
      }
      out[field.key] = value.toLowerCase()
      continue
    }
    if (field.type === 'checkbox') {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        return issue(field, `「${field.label}」的資料不對，請重新整理頁面。`)
      }
      const picked = [...new Set(value as string[])]
      const options = field.options ?? []
      if (picked.some((v) => !options.includes(v))) return issue(field, `「${field.label}」有不在選項裡的值，請重新整理頁面。`)
      if (picked.length > 0) out[field.key] = options.filter((o) => picked.includes(o))
      continue
    }
    if (typeof value !== 'string') return issue(field, `「${field.label}」的資料不對，請重新整理頁面。`)
    if (CHOICE_ONE.has(field.type)) {
      if (value === '') continue
      if (!(field.options ?? []).includes(value)) return issue(field, `「${field.label}」的選項不存在，請重新整理頁面。`)
      out[field.key] = value
      continue
    }
    const text = field.type === 'textarea' ? cleanText(value) : cleanLine(value)
    const max = field.type === 'textarea' ? TEXTAREA_MAX_LENGTH : LINE_MAX_LENGTH
    if (text.length > max) return issue(field, `「${field.label}」最多 ${max} 字。`)
    if (text !== '') out[field.key] = text
  }
  return { ok: true, value: out }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const NUMBER = /^-?\d+(\.\d+)?$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

function isRealDate(value: string): boolean {
  if (!DATE.test(value)) return false
  const [y, m, d] = value.split('-').map(Number) as [number, number, number]
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function isEmpty(value: AnswerValue | undefined): boolean {
  return value === undefined || (typeof value === 'string' ? value.trim() === '' : value.length === 0)
}

function missingMessage(field: FormField): string {
  if (field.type === 'file') return `請上傳「${field.label}」`
  if (field.type === 'radio' || field.type === 'select') return `請選擇「${field.label}」`
  if (field.type === 'checkbox') return `請勾選「${field.label}」`
  return `請填寫「${field.label}」`
}

function formatMessage(field: FormField, value: string): string | null {
  switch (field.type) {
    case 'email':
      return EMAIL.test(value) ? null : `「${field.label}」不是有效的 Email`
    case 'url':
      return isHttpUrl(value) ? null : `「${field.label}」要是 http:// 或 https:// 開頭的網址`
    case 'number':
      return NUMBER.test(value) ? null : `「${field.label}」要填數字`
    case 'date':
      return isRealDate(value) ? null : `「${field.label}」的日期格式不對`
    case 'time':
      return TIME.test(value) ? null : `「${field.label}」的時間格式不對`
    default:
      return null
  }
}

/**
 * 正式送出前的檢查（產品模組 05 §4.6：空白不能拿到回執）。回傳每個有問題的欄位；空陣列＝可以送。
 * 必填沒填、格式不對都列出來，畫面照順序顯示、點了跳到那一欄。
 */
export function submitIssues(fields: readonly FormField[], answers: Answers): FieldIssue[] {
  const issues: FieldIssue[] = []
  for (const field of answerFields(fields)) {
    const value = answers[field.key]
    if (isEmpty(value)) {
      if (field.required) issues.push({ key: field.key, label: field.label, message: missingMessage(field) })
      continue
    }
    if (typeof value === 'string') {
      const bad = formatMessage(field, value)
      if (bad) issues.push({ key: field.key, label: field.label, message: bad })
    }
  }
  return issues
}

export function describeIssues(issues: readonly FieldIssue[]): string {
  return `還不能正式送出：${issues.map((i) => i.message).join('；')}。`
}

// ── 開放與截止 ──────────────────────────────────────────────────────────────

/**
 * 收件現在在哪個階段（產品模組 05 §5「未開放→可填草稿→已送出／可重送→截止鎖定」）。
 *
 * - 尚未開放：看**設定的**開放時間 `opens_at`（沒設＝發布即開放）。票 15 的「實際開放時間」記的是第一次發布的當下，
 *   即使設了未來的開放時間也一樣，所以不能拿它判斷學生能不能填。
 * - 已截止：業務時間已經過了截止分鐘（`received < 截止分鐘起點 + 1 分鐘` 都算準時，母 spec §4.11）。
 */
export type Phase = 'not_open' | 'open' | 'closed'

export function phaseOf(window: { readonly opensAt: Date | null; readonly dueAt: Date | null }, businessNow: Date): Phase {
  if (window.opensAt && businessNow.getTime() < window.opensAt.getTime()) return 'not_open'
  if (window.dueAt && isDeadlinePassed(businessNow, window.dueAt)) return 'closed'
  return 'open'
}

// ── 作業區狀態 ──────────────────────────────────────────────────────────────

export type StatusTone = 'success' | 'muted' | 'brand' | 'danger' | 'info'

export type ItemStatusView = {
  /** 第一行：尚未開放／未繳／已繳 v2／逾期未繳／免填。 */
  readonly headline: string
  readonly tone: StatusTone
  /** 第二行：開放時間、草稿已存、截止前可重送、截止後唯讀。 */
  readonly detail: string
  /** 列表按鈕的字。 */
  readonly action: string
  /** 待繳（進行中、還沒正式送出、不是免填）。 */
  readonly pending: boolean
  readonly submitted: boolean
  readonly overdue: boolean
  /** 還能不能存草稿與送出。 */
  readonly editable: boolean
}

export type StatusFacts = {
  readonly phase: Phase
  readonly opensAt: Date | null
  readonly latestVersionNo: number | null
  readonly hasDraft: boolean
  readonly exempt: boolean
}

/**
 * 作業區與內容頁共用的狀態字（原型 `student-status.ts` 的口徑：「是否已繳」「還能不能改」「逾期」分開講）。
 * 逾期只給「未繳且已截止」；已繳而截止是「截止後唯讀」，不是逾期。
 */
export function statusOf(facts: StatusFacts): ItemStatusView {
  const base = { pending: false, submitted: false, overdue: false, editable: false }
  if (facts.exempt) {
    return { ...base, headline: '免填', tone: 'muted', detail: '系辦已將你設為免填這份收件', action: '查看' }
  }
  if (facts.phase === 'not_open') {
    const when = facts.opensAt ? `${formatTaipeiMinute(facts.opensAt)} 開放` : '尚未開放'
    return { ...base, headline: '尚未開放', tone: 'info', detail: when, action: '查看' }
  }
  if (facts.latestVersionNo !== null) {
    const editable = facts.phase === 'open'
    return {
      ...base,
      submitted: true,
      editable,
      headline: `已繳 v${facts.latestVersionNo}`,
      tone: 'success',
      detail: editable ? '截止前可重送，以最後一次為準' : '截止後唯讀',
      action: editable ? '查看或重送' : '查看',
    }
  }
  if (facts.phase === 'closed') {
    return { ...base, overdue: true, headline: '逾期未繳', tone: 'danger', detail: '已截止・需要補交請聯絡系辦', action: '查看' }
  }
  if (facts.hasDraft) {
    return { ...base, pending: true, editable: true, headline: '未繳', tone: 'brand', detail: '草稿已存，尚未正式送出', action: '繼續填寫' }
  }
  return { ...base, pending: true, editable: true, headline: '未繳', tone: 'muted', detail: '進行中', action: '去繳交' }
}

// ── 回執 ────────────────────────────────────────────────────────────────────

/** 收件章上的一句話（伺服器產生，畫面只顯示）。整組一份時寫明「代表 G01 組」：一人送出＝全組已繳。 */
export function describeReceipt(receipt: {
  readonly title: string
  readonly versionNo: number
  readonly receivedBusinessAt: string
  readonly groupCode?: string | null
}): string {
  const who = receipt.groupCode ? `代表 ${receipt.groupCode} 組` : ''
  return `「${receipt.title}」已收件：${who}第 ${receipt.versionNo} 次正式送出，收件時間 ${formatTaipeiSecond(new Date(receipt.receivedBusinessAt))}（臺灣時間）。`
}
