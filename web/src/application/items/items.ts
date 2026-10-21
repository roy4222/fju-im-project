import type { ResolvedActor, Role } from '@/application/accounts'
import type { FileTypeId } from '@/application/ops'
import { formatTaipeiMinute, isValidTaipeiDate, parseTaipeiDateTime, type TaipeiDate } from '@/shared/time'

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

/**
 * 開放建立的位置：公告、資源、文件繳交（票 15），加上專題規則（票 16：前台 `/rules` 的內容也走同一個發布流程，
 * 產品模組 04 §4.2）、榮譽榜（第三波 W1：前台 `/honors` 與首頁「榮譽與競賽」）。其餘位置在後面的票。
 */
export const EDITABLE_PLACEMENTS = ['news', 'resource', 'submission', 'rules', 'honor'] as const
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
  rules: '前台「專題規則」頁的一節（長文）',
  honor: '前台「榮譽榜」的一則得獎消息，可附照片',
}

/**
 * 榮譽榜是公開頁（第三波 W1）：對象固定「公開訪客」、不收件、不發通知；而且是跨屆的公開紀錄，
 * 屆別封存後仍可編輯、下架、重新發布、刪除（其他位置封存後就不能動）。
 */
export const HONOR_PLACEMENT = 'honor' as const

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
 * 收件能用的對象（產品模組 04「單一入口與收件單位」2026-09-12 定案；C 階段規格① T3 加「全部老師」）：
 * 收件不開給公開訪客，也不用「所有已登入者」。給老師的作業一律個人一份（名單＝啟用中、有老師角色的帳號）。
 */
export const COLLECTION_AUDIENCES: readonly AudienceKind[] = ['cohort_students', 'groups', 'teachers']

/**
 * 同意書（C 階段規格① §1.1、§6.1）：作業的一種模式。
 * - `form`：站內同意表單，整組一份；每個對象組發布時建一個簽核包（`signoff_packages.item_id`），沒有繳交欄位、截止選填。
 * - `upload`：下載 PDF 簽名再上傳，就是一個個人一份、有檔案欄的作業，模式只影響標籤。
 * 不是同意書的作業是 null。
 */
export type ConsentMode = 'form' | 'upload'
export const CONSENT_MODES: readonly ConsentMode[] = ['form', 'upload']

/** 站內同意表單的用途（跟簽核包的 `purpose` 同一組值）：只有 `form` 有、而且一定要有。 */
export type ConsentPurpose = 'result_confirmation' | 'final_document'
export const CONSENT_PURPOSES: readonly ConsentPurpose[] = ['result_confirmation', 'final_document']
export const CONSENT_PURPOSE_LABEL: Readonly<Record<ConsentPurpose, string>> = {
  result_confirmation: '期中結果確認',
  final_document: '最終文件授權',
}

export type ReceiverUnit = 'none' | 'individual' | 'group'
export const RECEIVER_UNIT_LABEL: Readonly<Record<ReceiverUnit, string>> = {
  none: '不用繳交',
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

/**
 * 競賽資訊是公告的一個分類（產品模組 09 §9.2；`PLACEMENT_HINT.news`）。分類填這個字的公告出現在前台 `/competitions`，
 * 而且可以填報名截止日與活動日（0011，票 39），前台用這兩天推「報名中／決賽／已結束」（`competitionStatus`）。
 */
export const COMPETITION_CATEGORY = '競賽資訊'

/** 競賽狀態（原型 `CompetitionStatus`；Roy 2026-09-08：狀態由日期推導，後台只填兩個日期、不手動切換）。 */
export type CompetitionStatus = 'open' | 'result' | 'closed'

/**
 * 截止日（含當天）還沒過＝報名中；活動日（含當天）還沒過＝決賽／結果；都過了＝已結束（原型 `competitionStatus`）。
 * 只填一個就只看那一個；兩個都沒填回 null（畫面不放狀態 pill，歸在「全部」；原型假設一定有截止日）。
 */
export function competitionStatus(
  dates: { readonly registrationDeadline: TaipeiDate | null; readonly eventDate: TaipeiDate | null },
  today: TaipeiDate,
): CompetitionStatus | null {
  const { registrationDeadline, eventDate } = dates
  if (registrationDeadline === null && eventDate === null) return null
  if (registrationDeadline !== null && today <= registrationDeadline) return 'open'
  if (eventDate !== null && today <= eventDate) return 'result'
  return 'closed'
}

/**
 * 能不能置頂（第 1 批 V1；Q48-a）：只有**發布中的公告**可以置頂；其他回給系辦看的句子。
 * 取消置頂不檢查（撤回、下架時已自動清掉，剩下的一定是發布中的公告）。多則置頂不設上限（D9）。
 */
export function pinDenial(item: { readonly placement: string; readonly status: ItemStatus }): string | null {
  if (item.placement !== 'news') return '只有公告可以置頂。'
  if (item.status !== 'published') return '只有發布中的公告可以置頂，請先發布。'
  return null
}

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
  /** 所屬階段：C 階段起表單不再送（給 null 或空字串）；舊資料保留不刪。 */
  readonly stageId: string | null
  /** 同意書模式（`form`／`upload`）；不是同意書給 null、空字串或不給。只有作業能設。 */
  readonly consentMode?: string | null
  /** 站內同意表單的用途；只有 `consentMode='form'` 會留，其他一律清掉。 */
  readonly consentPurpose?: string | null
  /** `datetime-local`（臺灣時間）；空字串＝發布即開放。 */
  readonly opensAt: string
  /** `datetime-local`（臺灣時間）；秒數捨去，存截止分鐘的起點。 */
  readonly dueAt: string
  /** 競賽資訊的報名截止日（`YYYY-MM-DD`；空＝沒填）。只有分類「競賽資訊」的公告會留，其他一律清掉。 */
  readonly registrationDeadline?: string
  /** 競賽資訊的活動日（決賽、展出；`YYYY-MM-DD`；空＝沒填）。 */
  readonly eventDate?: string
  /** 榮譽榜的得獎日期（`YYYY-MM-DD`；空＝沒填，前台退回發布日）。只有榮譽會留，其他位置一律清掉。 */
  readonly awardedOn?: string
  /**
   * 指導老師閱覽（C 收尾 CL-13，從繳交狀況頁的面板移進表單）：`true` 開、`false` 關；不給或 `null`＝不動。
   * 只用在「個人一份」的作業；整組一份給 `true` 回錯，給 `false` 當不動。存檔跟表單其他欄位同一個交易。
   */
  readonly advisorVisibility?: boolean | null
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
  /** 表單不送（永遠 null，除非舊資料帶著）；發布不再檢查（C 階段規格① §1.1）。 */
  readonly stageId: string | null
  readonly consentMode: ConsentMode | null
  readonly consentPurpose: ConsentPurpose | null
  readonly opensAt: Date | null
  readonly dueAt: Date | null
  /** 競賽資訊的兩個日期（臺灣日曆日）；不是「公告＋分類競賽資訊」一律 null。 */
  readonly registrationDeadline: TaipeiDate | null
  readonly eventDate: TaipeiDate | null
  /** 榮譽榜的得獎日期（臺灣日曆日）；不是榮譽一律 null。 */
  readonly awardedOn: TaipeiDate | null
  /** 指導老師閱覽要改成什麼；`null`＝不動（不是個人一份的作業一律 null）。 */
  readonly advisorVisibility: boolean | null
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
      return invalid(`${where}的大小上限要是 1 到 ${FILE_FIELD_MAX_MIB} MB 的整數。`, 'fields')
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
  if (!EDITABLE_PLACEMENTS.includes(placement)) return invalid('請選擇顯示在哪一區：公告、資源、文件繳交、專題規則或榮譽／競賽。', 'placement')

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
  if (!AUDIENCE_KINDS.includes(audienceKind)) return invalid('請選擇誰看得到。', 'audienceKind')
  if (collects && !COLLECTION_AUDIENCES.includes(audienceKind)) {
    return invalid('作業只能發給「本屆學生」「指定組別」或「全部老師」。', 'audienceKind')
  }
  if (placement === HONOR_PLACEMENT && audienceKind !== 'public') {
    return invalid('榮譽榜是公開頁，對象只能是「公開訪客」。', 'audienceKind')
  }

  let receiverUnit: ReceiverUnit = 'none'
  if (collects) {
    const unit = String(input.receiverUnit)
    if (unit !== 'individual' && unit !== 'group') {
      return invalid('文件繳交要選繳交方式：個人一份或整組一份。', 'receiverUnit')
    }
    receiverUnit = unit
    if (audienceKind === 'teachers' && unit !== 'individual') {
      return invalid('給老師的作業一律個人一份。', 'receiverUnit')
    }
  }

  // 同意書：只有作業能設；站內表單一定整組一份、要選用途，上傳簽名檔一定個人一份（DB CHECK 同一條）。
  let consentMode: ConsentMode | null = null
  let consentPurpose: ConsentPurpose | null = null
  const rawMode = typeof input.consentMode === 'string' ? input.consentMode.trim() : ''
  if (collects && rawMode !== '') {
    if (!CONSENT_MODES.includes(rawMode as ConsentMode)) return invalid('同意書的形式不對，請重新選擇。', 'consentMode')
    consentMode = rawMode as ConsentMode
    if (consentMode === 'form') {
      if (receiverUnit !== 'group') return invalid('站內同意書是整組一份（每組一份、組員各自同意）。', 'receiverUnit')
      const rawPurpose = typeof input.consentPurpose === 'string' ? input.consentPurpose.trim() : ''
      if (!CONSENT_PURPOSES.includes(rawPurpose as ConsentPurpose)) {
        return invalid('請選同意書的用途：期中結果確認或最終文件授權。', 'consentPurpose')
      }
      consentPurpose = rawPurpose as ConsentPurpose
    } else if (receiverUnit !== 'individual') {
      return invalid('下載 PDF 簽名再上傳的同意書是個人一份。', 'receiverUnit')
    }
  }

  // 指導老師閱覽：只有個人一份的作業有；整組一份的正式版本本來就給目前的指導老師看。
  let advisorVisibility: boolean | null = null
  if (typeof input.advisorVisibility === 'boolean') {
    if (receiverUnit === 'individual') advisorVisibility = input.advisorVisibility
    else if (input.advisorVisibility) {
      return invalid('指導老師閱覽只用在「個人一份」的作業；整組一份的正式版本本來就給目前的指導老師看。', 'advisorVisibility')
    }
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

  // 競賽資訊的日期：只有「公告＋分類競賽資訊」才留（換位置或改分類就清掉，不留看不到的值）。
  let registrationDeadline: TaipeiDate | null = null
  let eventDate: TaipeiDate | null = null
  if (placement === 'news' && category === COMPETITION_CATEGORY) {
    const deadline = parseDay(input.registrationDeadline, '報名截止日', 'registrationDeadline')
    if (!deadline.ok) return deadline
    const event = parseDay(input.eventDate, '活動日', 'eventDate')
    if (!event.ok) return event
    registrationDeadline = deadline.value
    eventDate = event.value
    if (registrationDeadline && eventDate && eventDate < registrationDeadline) {
      return invalid('活動日不能早於報名截止日。', 'eventDate')
    }
  }

  // 榮譽的得獎日期：只有榮譽才留（換位置就清掉）。
  let awardedOn: TaipeiDate | null = null
  if (placement === HONOR_PLACEMENT) {
    const awarded = parseDay(input.awardedOn, '得獎日期', 'awardedOn')
    if (!awarded.ok) return awarded
    awardedOn = awarded.value
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
      consentMode,
      consentPurpose,
      opensAt,
      dueAt,
      registrationDeadline,
      eventDate,
      awardedOn,
      advisorVisibility,
      fields,
    },
  }
}

/** `YYYY-MM-DD`（`<input type="date">`）→ 臺灣日曆日；空＝null。 */
function parseDay(value: unknown, label: string, field: string): Normalized<TaipeiDate | null> {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return { ok: true, value: null }
  if (!isValidTaipeiDate(text)) return invalid(`${label}的格式不對，請重新選擇日期。`, field)
  return { ok: true, value: text }
}

// ── 發布前檢查 ──────────────────────────────────────────────────────────────

/** 空收件的固定文案（產品模組 04「發布檢查與時間邊界」Q-PUB01；模組實作設計 04 §3）。 */
export const EMPTY_COLLECTION_MESSAGE = '新增填寫欄位或上傳要求，或改用公告／資源'

export type PublishCheckKey = 'title' | 'audience' | 'due' | 'window' | 'fields' | 'consent_purpose' | 'consent_advisor' | 'consent_drafts'

export type PublishCheck = {
  readonly key: PublishCheckKey
  readonly label: string
  readonly ok: boolean
  /** 沒過時要怎麼補。 */
  readonly fix: string
}

export type PublishState = Pick<
  ItemDraft,
  'placement' | 'title' | 'audienceKind' | 'groupIds' | 'receiverUnit' | 'opensAt' | 'dueAt' | 'fields'
> &
  Partial<Pick<ItemDraft, 'consentMode' | 'consentPurpose'>> & {
    /**
     * 站內同意書要查資料庫的兩件事（由用例在檢查前查好；不是站內同意書不用給）：
     * `advisedGroupCount`＝對象組裡有主指導的組數（0 就擋：一包都建不起來）；
     * `groupsWithoutShowcaseDraft`＝最終文件授權時還沒有成果展示草稿的組代號（有就擋，列出組別）。
     */
    readonly consentFacts?: { readonly advisedGroupCount: number; readonly groupsWithoutShowcaseDraft: readonly string[] }
  }

/** 這份作業是不是站內同意表單（發布時建簽核包、不發「新作業」通知、沒有繳交欄位）。 */
export function isConsentForm(state: { readonly placement: Placement; readonly consentMode?: ConsentMode | null }): boolean {
  return collectsResponses(state.placement) && state.consentMode === 'form'
}

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
      label: '誰看得到',
      ok: state.audienceKind !== 'groups' || state.groupIds.length > 0,
      fix: '指定組別至少選一組',
    },
  ]
  if (collects) {
    const opens = state.opensAt ?? openAt
    const consentForm = isConsentForm(state)
    // 站內同意書：截止選填、沒有繳交欄位（同意在簽核包裡投）；所屬階段 C 階段起不再要求（§1.1）。
    if (!consentForm) checks.push({ key: 'due', label: '截止', ok: state.dueAt !== null, fix: '作業一定要有截止時間' })
    checks.push({
      key: 'window',
      label: '時間',
      ok: state.dueAt === null || state.dueAt.getTime() >= opens.getTime(),
      fix: state.opensAt ? '截止不能早於開放時間' : '截止不能早於開放時間（沒設開放＝發布當下就開放）',
    })
    if (!consentForm) {
      checks.push({ key: 'fields', label: '欄位', ok: state.fields.some(isInputField), fix: EMPTY_COLLECTION_MESSAGE })
    } else {
      checks.push({
        key: 'consent_purpose',
        label: '同意書用途',
        ok: state.consentPurpose !== null && state.consentPurpose !== undefined,
        fix: '在進階設定選用途：期中結果確認或最終文件授權',
      })
      if (state.consentFacts) {
        checks.push({
          key: 'consent_advisor',
          label: '指導老師',
          ok: state.consentFacts.advisedGroupCount > 0,
          fix: '對象組都還沒有指導老師，發布後一份同意書都建不起來；先指派老師或改對象',
        })
        if (state.consentPurpose === 'final_document') {
          const missing = state.consentFacts.groupsWithoutShowcaseDraft
          checks.push({
            key: 'consent_drafts',
            label: '成果展示草稿',
            ok: missing.length === 0,
            fix: `這些組還沒有成果展示草稿：${missing.join('、')}`,
          })
        }
      }
    }
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

/**
 * 看的人：匿名，或已登入者的角色、學生屆別、目前所在組別，以及（老師）目前指導的組別與那些組所在的屆別。
 *
 * `groupIds` 是**組員**身分（收件名單靠它）；`advisedGroupIds` 是**指導老師**身分
 * （`advisor_assignments` 的有效那一列），兩者分開，不互相混用（第三波 W4）。
 */
export type Viewer =
  | { readonly kind: 'anonymous' }
  | {
      readonly kind: 'user'
      readonly roles: readonly Role[]
      readonly studentCohortId: string | null
      readonly groupIds: readonly string[]
      readonly advisedGroupIds: readonly string[]
      readonly advisedCohortIds: readonly string[]
    }

export type ItemVisibility = {
  readonly status: ItemStatus
  readonly audienceKind: AudienceKind
  readonly cohortId: string
  readonly groupIds: readonly string[]
  /** 收件單位：指導老師（不論本屆學生或指定組別）只看得到不收件的項目（公告、資源）。 */
  readonly receiverUnit: ReceiverUnit
}

/**
 * 某人現在看不看得到某個項目（模組實作設計 04 §5 `AudienceResolver.canView`）。附件下載也用這個：
 * 誰能下載附件＝誰看得到這個項目（產品模組 04 §4.3：公開位置不代表所有欄位都公開，伺服器依 audience 過濾）。
 *
 * - 管理員：什麼狀態都看得到（要編輯）。
 * - 其他人：只看得到發布中的，而且要在對象內。草稿、下架都看不到。
 * - 本屆學生：該屆學生；**指導該屆任一組的老師**也看得到，但只限不收件的項目（Q13：唯讀看公告、範本，收件不給）。
 * - 指定組別：那幾組的組員；那幾組目前的指導老師也看得到，同樣只限不收件的（Q14；收件只給組員）。
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
      return (
        viewer.kind === 'user' &&
        ((viewer.studentCohortId !== null && viewer.studentCohortId === item.cohortId) ||
          (item.receiverUnit === 'none' && viewer.advisedCohortIds.includes(item.cohortId)))
      )
    case 'teachers':
      return viewer.kind === 'user' && viewer.roles.includes('teacher')
    case 'groups':
      return (
        viewer.kind === 'user' &&
        item.groupIds.some(
          (id) => viewer.groupIds.includes(id) || (item.receiverUnit === 'none' && viewer.advisedGroupIds.includes(id)),
        )
      )
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
