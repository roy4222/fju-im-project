import type { FormField, ItemDetail } from '@/application/items'
import { formatBytes } from '@/shared/format-bytes'
import { toTaipeiDateTimeInput } from '@/shared/time'

/**
 * 公告與作業共用表單 `ItemForm` 的資料形狀與純函式（票 15 起；C 階段規格① §2）。**不是** Client Component：
 * 伺服器頁面（把項目轉成表單初值）、前台直接編輯的 server action 與瀏覽器（送出前轉成 Server Action 的內容）都要用。
 */

// ── 畫面上用到的標籤（由伺服器頁面帶進來；app 對 application 只能帶型別） ─────────────

export type Option = { readonly value: string; readonly label: string; readonly hint?: string }

export type EditorVocabulary = {
  readonly placements: readonly Option[]
  readonly audiences: readonly Option[]
  readonly collectionAudiences: readonly string[]
  readonly units: readonly Option[]
  readonly fieldTypes: readonly Option[]
  readonly inputFieldTypes: readonly string[]
  readonly fileTypes: readonly string[]
  readonly fileMaxMiB: number
  readonly emptyCollectionMessage: string
  /** 公告分類填這個字（「競賽資訊」）才出現報名截止日與活動日兩格（0011，票 39）。 */
  readonly competitionCategory: string
  /** 站內同意書的用途（C 階段規格① §6.1）：期中結果確認／最終文件授權。 */
  readonly consentPurposes: readonly Option[]
  readonly uploads: {
    readonly attachment: { readonly accept: string; readonly maxMiB: number }
    readonly cover: { readonly accept: string; readonly maxMiB: number }
  }
  readonly groups: readonly { readonly id: string; readonly code: string; readonly memberCount: number }[]
}

// ── 表單狀態 ──────────────────────────────────────────────────────────────

export type FileChip = { readonly fileId: string; readonly name: string; readonly sizeBytes: number }

export type FieldDraft = {
  key: string
  type: string
  label: string
  required: boolean
  help: string
  options: string[]
  allowedTypes: string[]
  maxMiB: number
}

export type EditorState = {
  cohortId: string
  placement: string
  title: string
  summary: string
  body: string
  category: string
  cover: FileChip | null
  attachments: FileChip[]
  audienceKind: string
  groupIds: string[]
  receiverUnit: string
  /** 舊資料的所屬階段：C 階段起表單不顯示、不改，原樣送回（不送會被當成「改了設定」）。 */
  stageId: string
  /** 同意書模式（`form`／`upload`）；不是同意書是 null。由「新增」選單決定，表單裡不能改。 */
  consentMode: ConsentModeValue | null
  /** 站內同意書的用途（`result_confirmation`／`final_document`）；沒選是 ''。 */
  consentPurpose: string
  opensAt: string
  dueAt: string
  /** 競賽資訊的報名截止日與活動日（`YYYY-MM-DD`；空＝沒填）。 */
  registrationDeadline: string
  eventDate: string
  /** 榮譽榜的得獎日期（`YYYY-MM-DD`；空＝沒填，前台用發布日）。 */
  awardedOn: string
  fields: FieldDraft[]
}

/** 榮譽榜位置（第三波 W1）：對象固定公開訪客、不收件、不發通知。 */
export const HONOR = 'honor'
/** 榮譽固定的對象。 */
export const HONOR_AUDIENCE = 'public'

// ── `ItemForm` 的介面型別（§2.2、§2.7；凍結） ───────────────────────────────

export type ItemFormPlacement = 'news' | 'submission' | 'resource' | 'rules' | 'honor'
export type ConsentModeValue = 'form' | 'upload'
export type ItemStatusValue = 'draft' | 'published' | 'archived'

/**
 * 發布紀錄一筆（進階設定最下方「發布紀錄」；操作者頭像見總表 Y-4）。
 * 頭像網址由伺服器算好（`toInitial` 的 `avatarUrls`）：表單是按需載入的 chunk，不在 client 引 `AvatarImg`／頭像規則（`item-form-parts.tsx` 樣式段）。
 */
export type PublicationLog = {
  readonly action: string
  readonly notify: boolean
  readonly actorUserId: string
  readonly actorName: string
  /** 空字串＝呼叫端沒給（只畫灰色圓）。 */
  readonly actorAvatarUrl: string
  readonly realAt: Date
}

/**
 * 表單初值（§2.7）：編輯時由 `toInitial(detail)` 從 `ItemQuery.get` 的結果轉成，新增時由 `defaultItemDraft` 給。
 * 時間是 `datetime-local` 用的臺灣時間字串（到分鐘）；欄位已轉成表單產生器的列。
 */
export type ItemFormInitial = {
  readonly cohortId: string
  readonly placement: ItemFormPlacement
  readonly revision: number
  readonly status: ItemStatusValue
  readonly title: string
  readonly bodyHtml: string
  readonly summary: string
  readonly category: string
  readonly audienceKind: string
  readonly groupIds: readonly string[]
  readonly receiverUnit: string
  readonly stageId: string
  readonly opensAt: string
  readonly dueAt: string
  readonly fields: readonly FieldDraft[]
  readonly attachments: readonly FileChip[]
  readonly cover: FileChip | null
  /** 公告／資源發布時要不要逐人通知（「重要公告」）。不存資料庫，只是這一次發布的選擇。 */
  readonly important: boolean
  /** 個人作業的主指導閱覽（設定在繳交狀況頁，這裡只顯示目前的值）。 */
  readonly advisorVisible: boolean
  readonly consentMode: ConsentModeValue | null
  readonly consentPurpose: string
  readonly registrationDeadline: string
  readonly eventDate: string
  readonly awardedOn: string
  readonly hasResponses: boolean
  /** 已交過的組數（整組）或人數（個人）；算不到（例如前台）是 null，畫面改用不帶數字的句子。 */
  readonly responseCount: number | null
  /** 發布過（有發布紀錄）：下架或撤回後再發布，通知預設不勾（設計方案 2026-10-08 §7 系7）。 */
  readonly publications: readonly PublicationLog[]
}

/** `datetime-local` 用的臺灣時間（到分鐘）。 */
function minuteInput(instant: Date | null): string {
  return instant ? toTaipeiDateTimeInput(new Date(instant)).slice(0, 16) : ''
}

/** 舊的 `requirement`（需求表）以作業載入（§0.4）；新建一律 `submission`。 */
export function formPlacementOf(placement: string): ItemFormPlacement {
  if (placement === 'requirement') return 'submission'
  return (['news', 'submission', 'resource', 'rules', 'honor'] as const).find((p) => p === placement) ?? 'news'
}

/**
 * `ItemQuery.get` 的結果 → 表單初值（§2.7）。附件、指定組別、繳交欄位整份帶進來，前台只改標題也不會清掉（AC-6a）。
 * `avatarUrls`：發布紀錄操作者的頭像網址，跟 `detail.publications` 同順序（伺服器用 `@/composition/avatar-url` 算）。
 */
export function toInitial(detail: ItemDetail, responseCount: number | null = null, avatarUrls: readonly string[] = []): ItemFormInitial {
  return {
    cohortId: detail.cohortId,
    placement: formPlacementOf(detail.placement),
    revision: detail.revision,
    status: detail.status,
    title: detail.title,
    bodyHtml: detail.bodyHtml,
    summary: detail.summary,
    category: detail.category ?? '',
    audienceKind: detail.audienceKind,
    groupIds: [...detail.groupIds],
    receiverUnit: detail.receiverUnit,
    stageId: detail.stageId ?? '',
    opensAt: minuteInput(detail.opensAt),
    dueAt: minuteInput(detail.dueAt),
    fields: detail.fields.map(fieldFromSchema),
    attachments: detail.attachments.map((a) => ({ ...a })),
    cover: detail.cover ? { ...detail.cover } : null,
    important: false,
    advisorVisible: false,
    consentMode: detail.consentMode,
    consentPurpose: detail.consentPurpose ?? '',
    registrationDeadline: detail.registrationDeadline ?? '',
    eventDate: detail.eventDate ?? '',
    awardedOn: detail.awardedOn ?? '',
    hasResponses: detail.hasResponses,
    responseCount: detail.hasResponses ? responseCount : 0,
    publications: detail.publications.map((p, index) => ({
      action: p.action,
      notify: p.notify,
      actorUserId: p.actorUserId,
      actorName: p.actorName,
      actorAvatarUrl: avatarUrls[index] ?? '',
      realAt: p.realAt,
    })),
  }
}

/** 下載 PDF 再上傳的同意書：預設那一個檔案欄（不能刪；§6.1、AC-24）。 */
export const CONSENT_FILE_KEY = 'fsignedconsent'
export function consentFileField(): FieldDraft {
  return {
    key: CONSENT_FILE_KEY,
    type: 'file',
    label: '簽好的同意書',
    required: true,
    help: '',
    options: [],
    allowedTypes: ['pdf', 'jpg', 'png'],
    maxMiB: 20,
  }
}

/** 新增時的表單初值（§11.3 `defaultItemDraft`）：各位置的預設對象、繳交方式與欄位。 */
export function defaultItemDraft(
  placement: ItemFormPlacement,
  cohortId: string,
  options: { consentMode?: ConsentModeValue | null; presetGroupIds?: readonly string[] } = {},
): ItemFormInitial {
  const collects = placement === 'submission'
  const consentMode = collects ? (options.consentMode ?? null) : null
  const groups = options.presetGroupIds ?? []
  const audienceKind = placement === HONOR || placement === 'rules' ? HONOR_AUDIENCE : groups.length > 0 ? 'groups' : 'cohort_students'
  return {
    cohortId,
    placement,
    revision: 0,
    status: 'draft',
    title: '',
    bodyHtml: '',
    summary: '',
    category: '',
    audienceKind,
    groupIds: audienceKind === 'groups' ? [...groups] : [],
    // 作業預設整組一份；下載再上傳的同意書是個人一份（每人簽一份），站內同意書固定整組。
    receiverUnit: collects ? (consentMode === 'upload' ? 'individual' : 'group') : 'none',
    stageId: '',
    opensAt: '',
    dueAt: '',
    // 一般作業先放一個檔案欄（最常見的「上傳檔案」）；站內同意書沒有繳交欄位。
    fields: !collects || consentMode === 'form' ? [] : consentMode === 'upload' ? [consentFileField()] : [newField('file', '上傳檔案')],
    attachments: [],
    cover: null,
    important: false,
    advisorVisible: false,
    consentMode,
    consentPurpose: '',
    registrationDeadline: '',
    eventDate: '',
    awardedOn: '',
    hasResponses: false,
    responseCount: 0,
    publications: [],
  }
}

/** 表單初值 → 表單狀態（可編輯的那一份）。 */
export function stateFromInitial(initial: ItemFormInitial): EditorState {
  return {
    cohortId: initial.cohortId,
    placement: initial.placement,
    title: initial.title,
    summary: initial.summary,
    body: initial.bodyHtml,
    category: initial.category,
    cover: initial.cover,
    attachments: [...initial.attachments],
    audienceKind: initial.audienceKind,
    groupIds: [...initial.groupIds],
    receiverUnit: initial.receiverUnit,
    stageId: initial.stageId,
    consentMode: initial.consentMode,
    consentPurpose: initial.consentPurpose,
    opensAt: initial.opensAt,
    dueAt: initial.dueAt,
    registrationDeadline: initial.registrationDeadline,
    eventDate: initial.eventDate,
    awardedOn: initial.awardedOn,
    fields: initial.fields.map((f) => ({ ...f, options: [...f.options], allowedTypes: [...f.allowedTypes] })),
  }
}

/**
 * 新增頁換位置（`/editor/new` 的「顯示在哪一區」）：其他已填的內容保留，只把對象與繳交方式調成那個位置合法的值。
 * 欄位不自動補（換過來的人多半接著套範本或自己加；沒有欄位時發布會擋並說明），換成不收件時欄位留著但不送出。
 */
export function switchPlacement(state: EditorState, placement: ItemFormPlacement, collectionAudiences: readonly string[]): EditorState {
  const collects = placement === 'submission'
  const fixedPublic = placement === HONOR || placement === 'rules'
  let audienceKind = state.audienceKind
  if (fixedPublic) audienceKind = HONOR_AUDIENCE
  else if (collects && !collectionAudiences.includes(audienceKind)) audienceKind = 'cohort_students'
  return {
    ...state,
    placement,
    audienceKind,
    groupIds: audienceKind === 'groups' ? state.groupIds : [],
    receiverUnit: collects ? (state.receiverUnit === 'none' ? 'group' : state.receiverUnit) : 'none',
  }
}

let fieldSeq = 0
/** 欄位代號：`f` 開頭、小寫英數，瀏覽器端產生，伺服器再驗一次格式與唯一。 */
export function newFieldKey(): string {
  fieldSeq += 1
  return `f${Date.now().toString(36)}${fieldSeq}`
}

export function fieldFromSchema(field: FormField): FieldDraft {
  return {
    key: field.key,
    type: field.type,
    label: field.label,
    required: field.required,
    help: field.help ?? '',
    options: [...(field.options ?? [])],
    allowedTypes: [...(field.fileRules?.allowedTypes ?? ['pdf'])],
    maxMiB: field.fileRules?.maxMiB ?? 20,
  }
}

export function newField(type: string, label: string): FieldDraft {
  return {
    key: newFieldKey(),
    type,
    label,
    required: type === 'file',
    help: '',
    options: ['radio', 'checkbox', 'select'].includes(type) ? ['選項 1', '選項 2'] : [],
    allowedTypes: ['pdf'],
    maxMiB: 20,
  }
}

const CHOICE_TYPES = ['radio', 'checkbox', 'select']

/** 一列欄位 → 存檔的 `FormField`（學生端渲染與驗證吃這個；預覽也用它）。 */
export function toFormField(f: FieldDraft): FormField {
  return {
    key: f.key,
    type: f.type as FormField['type'],
    label: f.label,
    required: f.required,
    ...(f.help ? { help: f.help } : {}),
    ...(CHOICE_TYPES.includes(f.type) ? { options: f.options } : {}),
    ...(f.type === 'file' ? { fileRules: { allowedTypes: f.allowedTypes, maxMiB: f.maxMiB } as FormField['fileRules'] } : {}),
  }
}

/** 表單狀態 → Server Action 要的內容。 */
export function toPayload(state: EditorState) {
  const collects = state.placement === 'submission'
  const consentMode = collects ? state.consentMode : null
  return {
    cohortId: state.cohortId,
    placement: state.placement,
    title: state.title,
    summary: state.summary,
    body: state.body,
    category: state.category,
    coverFileId: state.cover?.fileId ?? null,
    attachmentFileIds: state.attachments.map((a) => a.fileId),
    // 榮譽榜是公開頁：對象一律公開訪客（畫面也鎖住，這裡再保證一次）。
    audienceKind: state.placement === HONOR ? HONOR_AUDIENCE : state.audienceKind,
    groupIds: state.placement !== HONOR && state.audienceKind === 'groups' ? state.groupIds : [],
    receiverUnit: collects ? state.receiverUnit : 'none',
    // 舊資料的階段原樣送回；新項目永遠是 null（C 階段起不再選）。
    stageId: collects && state.stageId ? state.stageId : null,
    consentMode,
    consentPurpose: consentMode === 'form' && state.consentPurpose ? state.consentPurpose : null,
    opensAt: collects ? state.opensAt : '',
    dueAt: collects ? state.dueAt : '',
    // 只有「公告＋分類競賽資訊」會留（伺服器再判一次；不是就清掉）。
    registrationDeadline: state.placement === 'news' ? state.registrationDeadline : '',
    eventDate: state.placement === 'news' ? state.eventDate : '',
    // 得獎日期只有榮譽會留（伺服器再判一次）。
    awardedOn: state.placement === HONOR ? state.awardedOn : '',
    fields:
      collects && consentMode !== 'form'
        ? state.fields.map((f) => ({
            key: f.key,
            type: f.type,
            label: f.label,
            required: f.required,
            help: f.help,
            ...(CHOICE_TYPES.includes(f.type) ? { options: f.options } : {}),
            ...(f.type === 'file' ? { fileRules: { allowedTypes: f.allowedTypes, maxMiB: f.maxMiB } } : {}),
          }))
        : [],
  }
}

/** 全頁送出後回清單時的提示（sessionStorage；清單頁的「新增」鈕讀出來顯示一次）。 */
export const ITEM_FLASH_KEY = 'fju-item-flash'

export function newRequestId(): string {
  return crypto.randomUUID()
}

/** 附件大小的顯示字：全站同一套（KB／MB，見 `shared/format-bytes.ts`）。 */
export const formatSize = formatBytes

// ── 必填當下就擋（§2.5） ──────────────────────────────────────────────────────

/** 會在畫面上標紅的欄位（順序＝畫面由上到下，「發布」時捲到第一個）。 */
export const ERROR_ORDER = ['audience', 'opensAt', 'dueAt', 'title', 'fields', 'consentPurpose'] as const
export type FormErrorKey = (typeof ERROR_ORDER)[number]
export type FormErrors = Partial<Record<FormErrorKey, string>>

/** 標題上限（跟伺服器同一個數）。 */
export const TITLE_MAX = 120

/**
 * 表單自己先擋的必填與時間（規則的權威仍在伺服器：`publishChecks`）。
 * `publish`＝按「發布」或「儲存更新」：整張驗；`draft`＝「儲存（先不發布）」：只要標題與時間先後對（草稿可以缺截止與欄位）。
 */
export function validateItemForm(
  state: EditorState,
  mode: 'publish' | 'draft',
  inputFieldTypes: readonly string[],
  emptyCollectionMessage: string,
): FormErrors {
  const errors: FormErrors = {}
  const collects = state.placement === 'submission'
  const consentForm = collects && state.consentMode === 'form'
  if (state.title.trim() === '') errors.title = '請填標題'
  else if (state.title.trim().length > TITLE_MAX) errors.title = `標題最多 ${TITLE_MAX} 字`
  if (collects && state.dueAt && state.opensAt && state.dueAt < state.opensAt) errors.dueAt = '截止不能早於開放時間'
  if (mode === 'draft') return errors
  if (state.placement !== HONOR && state.audienceKind === 'groups' && state.groupIds.length === 0) errors.audience = '指定組別至少選一組'
  if (collects && !consentForm && !state.dueAt && !errors.dueAt) errors.dueAt = '請填截止時間'
  if (collects && !consentForm && !state.fields.some((f) => inputFieldTypes.includes(f.type))) errors.fields = emptyCollectionMessage
  if (consentForm && !state.consentPurpose) errors.consentPurpose = '請在進階設定選同意書的用途'
  return errors
}

/** blur 當下只驗這一欄（AC-2：標題留空離開就紅字）。 */
export function blurError(state: EditorState, key: 'title' | 'dueAt'): string | undefined {
  if (key === 'title') return state.title.trim() === '' ? '請填標題' : undefined
  if (state.placement !== 'submission' || state.consentMode === 'form') return undefined
  if (!state.dueAt) return '請填截止時間'
  if (state.opensAt && state.dueAt < state.opensAt) return '截止不能早於開放時間'
  return undefined
}

/** 伺服器發布前檢查（`PublishCheckKey`）沒過 → 畫面上哪一欄標紅。 */
export function errorKeyOfCheck(check: string): FormErrorKey | null {
  switch (check) {
    case 'title':
      return 'title'
    case 'audience':
      return 'audience'
    case 'due':
    case 'window':
      return 'dueAt'
    case 'fields':
      return 'fields'
    case 'consent_purpose':
      return 'consentPurpose'
    default:
      return null
  }
}

/** 伺服器擋下的欄位（`details.field`）→ 畫面上哪一欄標紅。 */
export function errorKeyOfField(field: string | undefined): FormErrorKey | null {
  if (!field) return null
  if (field === 'title') return 'title'
  if (field === 'dueAt' || field === 'opensAt') return field === 'opensAt' ? 'opensAt' : 'dueAt'
  if (field === 'groupIds' || field === 'audienceKind') return 'audience'
  if (field === 'fields') return 'fields'
  if (field === 'consentPurpose') return 'consentPurpose'
  return null
}

// ── 表單產生器（§2.4）：拖放後的順序與鎖定規則 ────────────────────────────────

/** 拖放：把第 `from` 列放到第 `to` 列的位置（其他列依序往後擠）。超出範圍或同一列回原陣列。 */
export function moveField<T>(fields: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= fields.length || to >= fields.length) return [...fields]
  const next = [...fields]
  const [picked] = next.splice(from, 1)
  next.splice(to, 0, picked!)
  return next
}

/** 上移／下移一格（鍵盤與手機用）。到頂或到底回原陣列。 */
export function shiftField<T>(fields: readonly T[], index: number, delta: -1 | 1): T[] {
  return moveField(fields, index, index + delta)
}

/** 表單產生器下拉的型別（§2.4）：常用 8 種在前，其他折進「更多型別」。全部是既有 `FIELD_TYPES`。 */
export const MAIN_FIELD_TYPES = ['text', 'textarea', 'radio', 'checkbox', 'select', 'file', 'date', 'paragraph'] as const
export const MORE_FIELD_TYPES = ['number', 'email', 'url', 'time', 'heading'] as const

/** 欄位上限（既有）。 */
export const MAX_FIELDS = 50

/**
 * 一列能動哪些地方（§2.4、AC-5、AC-24）：
 * - 有人交過：結構鎖住（型別、必填、選項、檔案規則、順序、刪除、新增），只能改欄名與說明；
 * - 下載再上傳的同意書：「簽好的同意書」那一欄不能刪。
 */
export function fieldLock(
  field: Pick<FieldDraft, 'key'>,
  context: { readonly hasResponses: boolean; readonly consentMode: ConsentModeValue | null },
): { readonly structure: boolean; readonly removable: boolean } {
  const structure = context.hasResponses
  const pinned = context.consentMode === 'upload' && field.key === CONSENT_FILE_KEY
  return { structure, removable: !structure && !pinned }
}

/** 「已有 N 組交過，欄位結構不能改」（AC-5）；數字算不到時不寫數字。 */
export function lockedFieldsNotice(responseCount: number | null, receiverUnit: string): string {
  if (responseCount === null || responseCount <= 0) return '已經有人交過，欄位結構不能改'
  return `已有 ${responseCount} ${receiverUnit === 'individual' ? '人' : '組'}交過，欄位結構不能改`
}

// ── 發布前「會通知幾位」的說明 ─────────────────────────────────────────────────

/** 這次送出什麼情況會發通知：新公告／資源看「重要公告」、已發布的修改看「通知這次的修改」、榮譽榜一律不發。 */
export type NotifyWhen = 'important' | 'update' | 'never'

/** 公告／資源的人數說明（驗收第 2 章 P-06）：照實寫出「勾了才通知」，不要讓人以為一定會通知。 */
export function notifyPreviewText(count: number, when: NotifyWhen): string {
  if (when === 'never') return '榮譽榜不發站內通知。'
  if (count <= 0) return '這個對象目前沒有可以通知的人。'
  return when === 'important' ? `若勾選「重要公告」，會通知 ${count} 位。` : `若勾選通知這次的修改，會通知 ${count} 位。`
}

/** 公開與所有登入者＝全站有效帳號：重要公告預設不勾（Roy 2026-09-25）；其他對象預設勾。 */
export function broadAudience(audienceKind: string): boolean {
  return audienceKind === 'public' || audienceKind === 'signed_in'
}
