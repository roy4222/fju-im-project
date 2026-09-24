import type { FormField } from '@/application/items'

/**
 * 專題事務編輯器的資料形狀與純函式（票 15）。**不是** Client Component：
 * 伺服器頁面（把項目轉成編輯器狀態）與瀏覽器（送出前轉成 Server Action 的內容）都要用。
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
  readonly uploads: {
    readonly attachment: { readonly accept: string; readonly maxMiB: number }
    readonly cover: { readonly accept: string; readonly maxMiB: number }
  }
  readonly stages: readonly { readonly id: string; readonly label: string }[]
  readonly groups: readonly { readonly id: string; readonly code: string; readonly memberCount: number }[]
}

// ── 編輯器狀態 ──────────────────────────────────────────────────────────────

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
  stageId: string
  opensAt: string
  dueAt: string
  fields: FieldDraft[]
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

/** 編輯器狀態 → Server Action 要的內容。 */
export function toPayload(state: EditorState) {
  const collects = state.placement === 'submission'
  return {
    cohortId: state.cohortId,
    placement: state.placement,
    title: state.title,
    summary: state.summary,
    body: state.body,
    category: state.category,
    coverFileId: state.cover?.fileId ?? null,
    attachmentFileIds: state.attachments.map((a) => a.fileId),
    audienceKind: state.audienceKind,
    groupIds: state.audienceKind === 'groups' ? state.groupIds : [],
    receiverUnit: collects ? state.receiverUnit : 'none',
    stageId: collects && state.stageId ? state.stageId : null,
    opensAt: collects ? state.opensAt : '',
    dueAt: collects ? state.dueAt : '',
    fields: collects
      ? state.fields.map((f) => ({
          key: f.key,
          type: f.type,
          label: f.label,
          required: f.required,
          help: f.help,
          ...(['radio', 'checkbox', 'select'].includes(f.type) ? { options: f.options } : {}),
          ...(f.type === 'file' ? { fileRules: { allowedTypes: f.allowedTypes, maxMiB: f.maxMiB } } : {}),
        }))
      : [],
  }
}

export function newRequestId(): string {
  return crypto.randomUUID()
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MiB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`
  return `${bytes} B`
}

