import type { EditorVocabulary } from '@/app/dashboard/admin/affairs/item-form-model'
import {
  AUDIENCE_LABEL,
  COLLECTION_AUDIENCES,
  COMPETITION_CATEGORY,
  EDITABLE_PLACEMENTS,
  EMPTY_COLLECTION_MESSAGE,
  FIELD_TYPE_LABEL,
  FIELD_TYPES,
  FILE_FIELD_MAX_MIB,
  getItemQuery,
  INPUT_FIELD_TYPES,
  ITEM_UPLOAD,
  PLACEMENT_HINT,
  PLACEMENT_LABEL,
  RECEIVER_UNIT_LABEL,
  SUBMISSION_FILE_TYPES,
} from '@/composition/items'
import type { ConsentPurpose } from '@/application/items'

/**
 * 伺服器頁面替共用表單 `ItemForm` 準備的標籤與選項（Client Component 不能直接拿 application 的執行期值）。
 * C 階段起作業不再選「所屬階段」（規格① §2），所以不再帶階段清單。
 */

const EXTENSION: Record<string, string> = {
  pdf: '.pdf',
  docx: '.docx',
  xlsx: '.xlsx',
  pptx: '.pptx',
  png: '.png',
  jpg: '.jpg,.jpeg',
  zip: '.zip',
  csv: '.csv',
}

/** 站內同意書的用途（跟 `application/items` 的 `CONSENT_PURPOSE_LABEL` 同字；app 對 application 只能帶型別，鍵由型別鎖住）。 */
const CONSENT_PURPOSE_OPTIONS: Readonly<Record<ConsentPurpose, string>> = {
  result_confirmation: '期中結果確認',
  final_document: '最終文件授權',
}

const AUDIENCE_ORDER = ['cohort_students', 'groups', 'signed_in', 'teachers', 'public'] as const

export async function editorVocabulary(cohortId: string): Promise<EditorVocabulary> {
  const options = await getItemQuery().editorOptions(cohortId)
  return {
    placements: EDITABLE_PLACEMENTS.map((p) => ({ value: p, label: PLACEMENT_LABEL[p], hint: PLACEMENT_HINT[p] })),
    audiences: AUDIENCE_ORDER.map((a) => ({ value: a, label: AUDIENCE_LABEL[a] })),
    collectionAudiences: [...COLLECTION_AUDIENCES],
    units: (['none', 'individual', 'group'] as const).map((u) => ({ value: u, label: RECEIVER_UNIT_LABEL[u] })),
    fieldTypes: FIELD_TYPES.map((t) => ({ value: t, label: FIELD_TYPE_LABEL[t] })),
    inputFieldTypes: [...INPUT_FIELD_TYPES],
    fileTypes: [...SUBMISSION_FILE_TYPES],
    fileMaxMiB: FILE_FIELD_MAX_MIB,
    emptyCollectionMessage: EMPTY_COLLECTION_MESSAGE,
    competitionCategory: COMPETITION_CATEGORY,
    consentPurposes: (Object.keys(CONSENT_PURPOSE_OPTIONS) as ConsentPurpose[]).map((p) => ({ value: p, label: CONSENT_PURPOSE_OPTIONS[p] })),
    uploads: {
      attachment: {
        accept: ITEM_UPLOAD.attachment.allowedTypes.map((t) => EXTENSION[t]).join(','),
        maxMiB: ITEM_UPLOAD.attachment.maxBytes / (1024 * 1024),
      },
      cover: {
        accept: ITEM_UPLOAD.cover.allowedTypes.map((t) => EXTENSION[t]).join(','),
        maxMiB: ITEM_UPLOAD.cover.maxBytes / (1024 * 1024),
      },
    },
    groups: options.groups,
  }
}
