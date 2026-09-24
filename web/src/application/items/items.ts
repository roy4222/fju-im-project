import type { ResolvedActor, Role } from '@/application/accounts'
import type { FileTypeId } from '@/application/ops'
import { formatTaipeiMinute, parseTaipeiDateTime } from '@/shared/time'

/**
 * 專題事務的純規則（票 15；產品模組 04 §4.1–4.4、「單一入口與收件單位」「發布檢查與時間邊界」；
 * 模組 05 §4「個人填報與收件名單」；模組實作設計 04 §2、§3）。
 *
 * 這裡沒有資料庫也沒有框架：輸入整理、欄位結構、發布前檢查、誰看得到，都是可以單獨測的函式。
 * 交易、鎖、名單展開在 `infrastructure/items/pg-items.ts`。
 */

// ── 位置、對象、收件單位 ─────────────────────────────────────────────────────

/** 附錄 A 的七種主要發布位置（CHECK 全放）。 */
export type Placement = 'news' | 'resource' | 'submission' | 'requirement' | 'rules' | 'showcase' | 'honor'

/** 票 15 開放建立的三種：公告、資源、文件繳交（其餘位置在後面的票）。 */
export const EDITABLE_PLACEMENTS = ['news', 'resource', 'submission'] as const
export type EditablePlacement = (typeof EDITABLE_PLACEMENTS)[number]

export const PLACEMENT_LABEL: Readonly<Record<Placement, string>> = {
  news: '公告',
  resource: '資源下載',
  submission: '文件繳交',
  requirement: '專題需求',
  rules: '專題規則',
  showcase: '歷屆／優秀專題',
  honor: '榮譽／競賽',
}

export const PLACEMENT_HINT: Readonly<Record<EditablePlacement, string>> = {
  news: '公告、說明會、競賽資訊，可附檔案',
  resource: '給大家下載的範本或參考文件',
  submission: '學生在截止前填寫或上傳（個人一份或整組一份）',
}

export type AudienceKind = 'public' | 'signed_in' | 'cohort_students' | 'teachers' | 'groups'
export const AUDIENCE_KINDS: readonly AudienceKind[] = ['cohort_students', 'groups', 'signed_in', 'teachers', 'public']

export const AUDIENCE_LABEL: Readonly<Record<AudienceKind, string>> = {
  public: '公開訪客',
  signed_in: '所有已登入使用者',
  cohort_students: '本屆學生',
  teachers: '全部老師',
  groups: '指定組別',
}

/**
 * 收件能用的對象只有兩種（產品模組 04「單一入口與收件單位」2026-09-12 定案）：
 * 收件不開給公開訪客，也不用「所有已登入者」；本期也不開「全部老師」（Q-SUB04 過渡）。
 */
export const COLLECTION_AUDIENCES: readonly AudienceKind[] = ['cohort_students', 'groups']

export type ReceiverUnit = 'none' | 'individual' | 'group'
export const RECEIVER_UNIT_LABEL: Readonly<Record<ReceiverUnit, string>> = {
  none: '不收件',
  individual: '個人一份',
  group: '整組一份',
}

export type ItemStatus = 'draft' | 'published' | 'archived'
export const ITEM_STATUS_LABEL: Readonly<Record<ItemStatus, string>> = {
  draft: '草稿',
  published: '發布中',
  archived: '已下架',
}

export function collectsResponses(placement: Placement): boolean {
  return placement === 'submission' || placement === 'requirement'
}

// ── 收件欄位 ────────────────────────────────────────────────────────────────

/** 要學生填或交東西的欄位（產品模組 04 §4.4 v1 元件）。 */
export const INPUT_FIELD_TYPES = [
  'text',
  'textarea',
  'number',
  'email',
  'url',
  'radio',
  'checkbox',
  'select',
  'date',
  'time',
  'file',
] as const
/** 只給人看的區塊：區段標題、說明文字。 */
export const STATIC_FIELD_TYPES = ['heading', 'paragraph'] as const
export type FieldType = (typeof INPUT_FIELD_TYPES)[number] | (typeof STATIC_FIELD_TYPES)[number]
export const FIELD_TYPES: readonly FieldType[] = [...INPUT_FIELD_TYPES, ...STATIC_FIELD_TYPES]

export const FIELD_TYPE_LABEL: Readonly<Record<FieldType, string>> = {
  text: '短文字',
  textarea: '長文字',
  number: '數字',
  email: 'Email',
  url: '網址',
  radio: '單選',
  checkbox: '複選',
  select: '下拉選單',
  date: '日期',
  time: '時間',
  file: '檔案上傳',
  heading: '區段標題',
  paragraph: '說明文字',
}

const CHOICE_TYPES: ReadonlySet<FieldType> = new Set(['radio', 'checkbox', 'select'])

/** 學生上傳可以選的類型（模組 10 §11.2 的子集；CSV 只給名單匯入用）。 */
export const SUBMISSION_FILE_TYPES: readonly FileTypeId[] = ['pdf', 'docx', 'xlsx', 'pptx', 'png', 'jpg', 'zip']
export const FILE_FIELD_MAX_MIB = 100

export type FileRules = { readonly allowedTypes: readonly FileTypeId[]; readonly maxMiB: number }

export type FormField = {
  readonly key: string
  readonly type: FieldType
  readonly label: string
  readonly required: boolean
  readonly help?: string
  readonly options?: readonly string[]
  readonly fileRules?: FileRules
}

export type FormSchema = { readonly fields: readonly FormField[] }

export function isInputField(field: Pick<FormField, 'type'>): boolean {
  return (INPUT_FIELD_TYPES as readonly string[]).includes(field.type)
}

export const MAX_FIELDS = 50
const FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/

// ── 輸入整理 ────────────────────────────────────────────────────────────────

export const TITLE_MAX_LENGTH = 120
export const SUMMARY_MAX_LENGTH = 300
export const BODY_MAX_LENGTH = 50_000
export const CATEGORY_MAX_LENGTH = 40
export const MAX_ATTACHMENTS = 20
export const MAX_AUDIENCE_GROUPS = 200

/** 表單送來的原樣（字串為主，時間是 `datetime-local` 的臺灣時間）。 */
export type ItemInput = {
  readonly cohortId: string
  readonly placement: string
  readonly title: string
  readonly summary: string
  readonly body: string
  readonly category: string
  readonly coverFileId: string | null
  readonly attachmentFileIds: readonly string[]
  readonly audienceKind: string
  readonly groupIds: readonly string[]
  readonly receiverUnit: string
  readonly stageId: string | null
  /** `datetime-local`（臺灣時間）；空字串＝發布即開放。 */
  readonly opensAt: string
  /** `datetime-local`（臺灣時間）；秒數捨去，存截止分鐘的起點。 */
  readonly dueAt: string
  readonly fields: readonly unknown[]
}

/** 整理過、可以存的樣子。正文在這一步**還沒**清理（清理在 `rich-text.ts`，由用例呼叫）。 */
export type ItemDraft = {
  readonly cohortId: string
  readonly placement: EditablePlacement
  readonly title: string
  readonly summary: string
  readonly body: string
  readonly category: string | null
  readonly coverFileId: string | null
  readonly attachmentFileIds: readonly string[]
  readonly audienceKind: AudienceKind
  readonly groupIds: readonly string[]
  readonly receiverUnit: ReceiverUnit
  readonly stageId: string | null
  readonly opensAt: Date | null
  readonly dueAt: Date | null
  readonly fields: readonly FormField[]
}

export type Invalid = { readonly ok: false; readonly message: string; readonly field?: string }
export type Normalized<T> = { readonly ok: true; readonly value: T } | Invalid

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

function invalid(message: string, field?: string): Invalid {
  return { ok: false, message, field }
}

function cleanLine(value: unknown): string {
  if (typeof value !== 'string') return ''
  // 控制字元換成空白（一行字裡不該有換行、Tab、NUL）。
  return [...value].map((ch) => (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f ? ' ' : ch)).join('').trim()
}

/** 截止與開放只到分鐘：秒數捨去。 */
function minuteOf(instant: Date): Date {
  return new Date(Math.floor(instant.getTime() / 60_000) * 60_000)
}

function parseMoment(raw: string, what: string, field: string): Normalized<Date | null> {
  const text = raw.trim()
  if (text === '') return { ok: true, value: null }
  const parsed = parseTaipeiDateTime(text)
  if (!parsed) return invalid(`${what}的格式不對，請重新選擇日期與時間。`, field)
  return { ok: true, value: minuteOf(parsed) }
}

function uuidList(values: readonly string[], max: number, what: string, field: string): Normalized<string[]> {
  if (!Array.isArray(values)) return invalid(`${what}的資料不對，請重新整理頁面。`, field)
  const unique = [...new Set(values.map((v) => String(v).toLowerCase()))]
  if (unique.some((v) => !isUuid(v))) return invalid(`${what}的資料不對，請重新整理頁面。`, field)
  if (unique.length > max) return invalid(`${what}最多 ${max} 個。`, field)
  return { ok: true, value: unique }
}

/** 一個欄位：型別、標籤、選項、檔案規則都整理過；不合規則回 Invalid（帶第幾欄）。 */
export function normalizeField(raw: unknown, index: number): Normalized<FormField> {
  const where = `第 ${index + 1} 個欄位`
  if (typeof raw !== 'object' || raw === null) return invalid(`${where}的資料不對。`, 'fields')
  const r = raw as Record<string, unknown>
  const type = String(r.type ?? '') as FieldType
  if (!FIELD_TYPES.includes(type)) return invalid(`${where}的類型不支援。`, 'fields')
  const key = String(r.key ?? '')
  if (!FIELD_KEY.test(key)) return invalid(`${where}的代號不對，請重新整理頁面。`, 'fields')
  const label = cleanLine(r.label)
  if (type !== 'paragraph' && label === '') return invalid(`${where}要有標籤。`, 'fields')
  const labelMax = type === 'paragraph' ? 1000 : 200
  if (label.length > labelMax) return invalid(`${where}的文字最多 ${labelMax} 字。`, 'fields')
  const help = cleanLine(r.help)
  if (help.length > 300) return invalid(`${where}的說明最多 300 字。`, 'fields')
  const input = (INPUT_FIELD_TYPES as readonly string[]).includes(type)

  let options: string[] | undefined
  if (CHOICE_TYPES.has(type)) {
    const list = Array.isArray(r.options) ? r.options.map(cleanLine).filter((o) => o !== '') : []
    if (list.length === 0) return invalid(`${where}（${FIELD_TYPE_LABEL[type]}）至少要有一個選項。`, 'fields')
    if (list.length > 30) return invalid(`${where}最多 30 個選項。`, 'fields')
    if (new Set(list).size !== list.length) return invalid(`${where}有重複的選項。`, 'fields')
    if (list.some((o) => o.length > 100)) return invalid(`${where}的選項每個最多 100 字。`, 'fields')
    options = list
  }

  let fileRules: FileRules | undefined
  if (type === 'file') {
    const given = (r.fileRules ?? {}) as Record<string, unknown>
    const types = Array.isArray(given.allowedTypes) ? given.allowedTypes.map(String) : ['pdf']
    const allowed = SUBMISSION_FILE_TYPES.filter((t) => types.includes(t))
    if (allowed.length === 0) return invalid(`${where}至少要允許一種檔案類型。`, 'fields')
    const maxMiB = given.maxMiB === undefined ? 20 : Number(given.maxMiB)
    if (!Number.isInteger(maxMiB) || maxMiB < 1 || maxMiB > FILE_FIELD_MAX_MIB) {
      return invalid(`${where}的大小上限要是 1 到 ${FILE_FIELD_MAX_MIB} MiB 的整數。`, 'fields')
    }
    fileRules = { allowedTypes: allowed, maxMiB }
  }

  return {
    ok: true,
    value: {
      key,
      type,
      label,
      required: input && r.required === true,
      ...(help ? { help } : {}),
      ...(options ? { options } : {}),
      ...(fileRules ? { fileRules } : {}),
    },
  }
}

export function normalizeSchema(rawFields: readonly unknown[]): Normalized<FormField[]> {
  if (!Array.isArray(rawFields)) return invalid('欄位資料不對，請重新整理頁面。', 'fields')
  if (rawFields.length > MAX_FIELDS) return invalid(`欄位最多 ${MAX_FIELDS} 個。`, 'fields')
  const fields: FormField[] = []
  for (const [index, raw] of rawFields.entries()) {
    const field = normalizeField(raw, index)
    if (!field.ok) return field
    fields.push(field.value)
  }
  if (new Set(fields.map((f) => f.key)).size !== fields.length) {
    return invalid('有兩個欄位的代號重複，請重新整理頁面。', 'fields')
  }
  return { ok: true, value: fields }
}

/**
 * 表單 → 可以存的草稿。**草稿可以不完整**（對象還沒選組、截止還沒填都能存），
 * 完整性在發布前檢查（`publishChecks`）；這裡只擋「存了也沒有意義」或「違反資料約束」的東西：
 * 位置、收件單位與對象的組合、時間格式、截止早於開放、欄位結構。
 */
export function normalizeItemInput(input: ItemInput): Normalized<ItemDraft> {
  if (!isUuid(input.cohortId)) return invalid('請選擇屆別。', 'cohortId')
  const placement = String(input.placement) as EditablePlacement
  if (!EDITABLE_PLACEMENTS.includes(placement)) return invalid('請選擇發布位置：公告、資源或文件繳交。', 'placement')

  const title = cleanLine(input.title)
  if (title === '') return invalid('請填標題。', 'title')
  if (title.length > TITLE_MAX_LENGTH) return invalid(`標題最多 ${TITLE_MAX_LENGTH} 字。`, 'title')
  const summary = cleanLine(input.summary)
  if (summary.length > SUMMARY_MAX_LENGTH) return invalid(`摘要最多 ${SUMMARY_MAX_LENGTH} 字。`, 'summary')
  const body = typeof input.body === 'string' ? input.body : ''
  if (body.length > BODY_MAX_LENGTH) return invalid(`正文最多 ${BODY_MAX_LENGTH} 字。`, 'body')
  const category = cleanLine(input.category)
  if (category.length > CATEGORY_MAX_LENGTH) return invalid(`分類最多 ${CATEGORY_MAX_LENGTH} 字。`, 'category')

  const collects = collectsResponses(placement)
  const audienceKind = String(input.audienceKind) as AudienceKind
  if (!AUDIENCE_KINDS.includes(audienceKind)) return invalid('請選擇發布對象。', 'audienceKind')
  if (collects && !COLLECTION_AUDIENCES.includes(audienceKind)) {
    return invalid('收件只能發給「本屆學生」或「指定組別」。', 'audienceKind')
  }

  let receiverUnit: ReceiverUnit = 'none'
  if (collects) {
    const unit = String(input.receiverUnit)
    if (unit !== 'individual' && unit !== 'group') {
      return invalid('文件繳交要選收件單位：個人一份或整組一份。', 'receiverUnit')
    }
    receiverUnit = unit
  }

  const groups = uuidList(audienceKind === 'groups' ? input.groupIds : [], MAX_AUDIENCE_GROUPS, '指定組別', 'groupIds')
  if (!groups.ok) return groups
  const attachments = uuidList(input.attachmentFileIds, MAX_ATTACHMENTS, '附件', 'attachments')
  if (!attachments.ok) return attachments
  const coverFileId = input.coverFileId === null || input.coverFileId === '' ? null : String(input.coverFileId).toLowerCase()
  if (coverFileId !== null && !isUuid(coverFileId)) return invalid('封面的資料不對，請重新上傳。', 'cover')

  let stageId: string | null = null
  let opensAt: Date | null = null
  let dueAt: Date | null = null
  let fields: FormField[] = []
  if (collects) {
    if (input.stageId !== null && input.stageId !== '') {
      if (!isUuid(input.stageId)) return invalid('所屬階段的資料不對，請重新選擇。', 'stageId')
      stageId = input.stageId.toLowerCase()
    }
    const opens = parseMoment(input.opensAt, '開放時間', 'opensAt')
    if (!opens.ok) return opens
    const due = parseMoment(input.dueAt, '截止時間', 'dueAt')
    if (!due.ok) return due
    opensAt = opens.value
    dueAt = due.value
    if (opensAt && dueAt && dueAt.getTime() < opensAt.getTime()) {
      return invalid('截止時間不能早於開放時間。', 'dueAt')
    }
    const schema = normalizeSchema(input.fields)
    if (!schema.ok) return schema
    fields = schema.value
  }

  return {
    ok: true,
    value: {
      cohortId: input.cohortId.toLowerCase(),
      placement,
      title,
      summary,
      body,
      category: category === '' ? null : category,
      coverFileId,
      attachmentFileIds: attachments.value,
      audienceKind,
      groupIds: groups.value,
      receiverUnit,
      stageId,
      opensAt,
      dueAt,
      fields,
    },
  }
}

// ── 發布前檢查 ──────────────────────────────────────────────────────────────

/** 空收件的固定文案（產品模組 04「發布檢查與時間邊界」Q-PUB01；模組實作設計 04 §3）。 */
export const EMPTY_COLLECTION_MESSAGE = '新增填寫欄位或上傳要求，或改用公告／資源'

export type PublishCheckKey = 'title' | 'audience' | 'stage' | 'due' | 'window' | 'fields'

export type PublishCheck = {
  readonly key: PublishCheckKey
  readonly label: string
  readonly ok: boolean
  /** 沒過時要怎麼補。 */
  readonly fix: string
}

export type PublishState = Pick<
  ItemDraft,
  'placement' | 'title' | 'audienceKind' | 'groupIds' | 'receiverUnit' | 'stageId' | 'opensAt' | 'dueAt' | 'fields'
>

/**
 * 發布前檢查（模組實作設計 04 §3「draft→published」）。畫面與用例用同一份：
 * 畫面拿來顯示清單，用例拿來擋（任何一條沒過就 `VALIDATION_FAILED`，不寫任何東西）。
 *
 * `openAt` 是這次發布的「開放時間」：有設開放就用設定的，沒設就是現在（發布即開放）；
 * 已經發布過的項目用第一次發布時記下的實際開放時間。
 */
export function publishChecks(state: PublishState, openAt: Date): PublishCheck[] {
  const collects = collectsResponses(state.placement)
  const checks: PublishCheck[] = [
    { key: 'title', label: '標題', ok: state.title.trim() !== '', fix: '填標題' },
    {
      key: 'audience',
      label: '對象',
      ok: state.audienceKind !== 'groups' || state.groupIds.length > 0,
      fix: '指定組別至少選一組',
    },
  ]
  if (collects) {
    const opens = state.opensAt ?? openAt
    checks.push(
      { key: 'stage', label: '所屬階段', ok: state.stageId !== null, fix: '選這份收件屬於哪個階段' },
      { key: 'due', label: '截止', ok: state.dueAt !== null, fix: '收件一定要有截止時間' },
      {
        key: 'window',
        label: '時間',
        ok: state.dueAt === null || state.dueAt.getTime() >= opens.getTime(),
        fix: state.opensAt ? '截止不能早於開放時間' : '截止不能早於開放時間（沒設開放＝發布當下就開放）',
      },
      {
        key: 'fields',
        label: '欄位',
        ok: state.fields.some(isInputField),
        fix: EMPTY_COLLECTION_MESSAGE,
      },
    )
  }
  return checks
}

export function failedChecks(checks: readonly PublishCheck[]): PublishCheck[] {
  return checks.filter((c) => !c.ok)
}

/** 擋下發布時給人看的一句話：第一條沒過的，後面幾條一起列。 */
export function describeFailedChecks(failed: readonly PublishCheck[]): string {
  if (failed.length === 0) return ''
  return `還不能發布：${failed.map((c) => `${c.label}—${c.fix}`).join('；')}。`
}

// ── 截止顯示與到期工作 ───────────────────────────────────────────────────────

/** 詳細畫面的截止文案（產品模組 04「發布檢查與時間邊界」）。 */
export function describeDeadline(dueAt: Date): string {
  return `截止：${formatTaipeiMinute(dueAt)}（含此分鐘，臺灣時間）`
}

/** 截止快照的寬限（系統架構 §到期工作：`deadline_snapshot` 在截止分鐘結束後再等 60 秒）。 */
export const SNAPSHOT_GRACE_MS = 60_000

/** `due_work(deadline_snapshot)` 的到期時間＝截止分鐘結束＋寬限。 */
export function snapshotDueAt(dueAt: Date): Date {
  return new Date(dueAt.getTime() + 60_000 + SNAPSHOT_GRACE_MS)
}

// ── 誰看得到 ────────────────────────────────────────────────────────────────

/** 看的人：匿名，或已登入者的角色、學生屆別與目前所在組別。 */
export type Viewer =
  | { readonly kind: 'anonymous' }
  | {
      readonly kind: 'user'
      readonly roles: readonly Role[]
      readonly studentCohortId: string | null
      readonly groupIds: readonly string[]
    }

export type ItemVisibility = {
  readonly status: ItemStatus
  readonly audienceKind: AudienceKind
  readonly cohortId: string
  readonly groupIds: readonly string[]
}

/**
 * 某人現在看不看得到某個項目（模組實作設計 04 §5 `AudienceResolver.canView`）。附件下載也用這個：
 * 誰能下載附件＝誰看得到這個項目（產品模組 04 §4.3：公開位置不代表所有欄位都公開，伺服器依 audience 過濾）。
 *
 * - 管理員：什麼狀態都看得到（要編輯）。
 * - 其他人：只看得到發布中的，而且要在對象內。草稿、下架都看不到。
 */
export function canViewItem(viewer: Viewer, item: ItemVisibility): boolean {
  if (viewer.kind === 'user' && viewer.roles.includes('admin')) return true
  if (item.status !== 'published') return false
  switch (item.audienceKind) {
    case 'public':
      return true
    case 'signed_in':
      return viewer.kind === 'user'
    case 'cohort_students':
      return viewer.kind === 'user' && viewer.studentCohortId !== null && viewer.studentCohortId === item.cohortId
    case 'teachers':
      return viewer.kind === 'user' && viewer.roles.includes('teacher')
    case 'groups':
      return viewer.kind === 'user' && viewer.groupIds.some((id) => item.groupIds.includes(id))
  }
}

/** 已登入者的學生屆別（沒有學生角色回 null）。 */
export function studentCohortOf(actor: ResolvedActor): string | null {
  if (actor.kind !== 'authenticated' || !actor.roles.includes('student')) return null
  return actor.cohortMemberships.find((m) => m.role === 'student')?.cohortId ?? null
}

export function isAdmin(actor: ResolvedActor): boolean {
  return actor.kind === 'authenticated' && actor.roles.includes('admin')
}

// ── 上傳規則 ────────────────────────────────────────────────────────────────

export type ItemFileKind = 'attachment' | 'cover'

/** 附件：常見文件＋圖片＋壓縮檔；封面：只收圖片。上限再跟環境上限取小。 */
export const ITEM_UPLOAD: Readonly<Record<ItemFileKind, { allowedTypes: readonly FileTypeId[]; maxBytes: number }>> = {
  attachment: { allowedTypes: ['pdf', 'docx', 'xlsx', 'pptx', 'png', 'jpg', 'zip'], maxBytes: 50 * 1024 * 1024 },
  cover: { allowedTypes: ['png', 'jpg'], maxBytes: 5 * 1024 * 1024 },
}
