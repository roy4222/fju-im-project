import type { FileRules } from '@/application/items'

/**
 * 交作業檔案欄的瀏覽器端預檢（C 階段規格① §5.2、S7；AC-17）：選檔的 `change` 當下就檢查大小與類型，
 * 不合就清掉並在欄位下寫紅字，**不**去要上傳憑證、不送任何位元組。
 *
 * 只是讓學生早點知道；伺服器的上傳仍照欄位規則再驗一次（含看內容的類型檢查），這裡放過的不代表收得下。
 * 上限一律讀欄位的 `fileRules.maxMiB`（系辦在表單設的值），不寫死數字。
 */

const MIB = 1024 * 1024

/** 欄位沒寫規則時的預設（同 `normalizeField` 的預設：PDF、20 MB）。 */
export const DEFAULT_FILE_RULES: FileRules = { allowedTypes: ['pdf'], maxMiB: 20 }

/** 每種類型接受的副檔名（`jpg` 也收 `.jpeg`）。 */
function extensionsOf(type: string): readonly string[] {
  return type === 'jpg' ? ['jpg', 'jpeg'] : [type]
}

/** `<input type=file accept=…>` 的值。 */
export function acceptOf(rules: FileRules): string {
  return rules.allowedTypes.flatMap((t) => extensionsOf(t).map((e) => `.${e}`)).join(',')
}

/** 類型的顯示字：`PDF`、`PDF、JPG、PNG`。 */
export function typesText(rules: FileRules): string {
  return rules.allowedTypes.map((t) => t.toUpperCase()).join('、')
}

/** 「寫作業」鈕旁、檔案欄說明用的上限字：`PDF・20 MB 以內`。 */
export function limitText(rules: FileRules): string {
  return `${typesText(rules)}・${rules.maxMiB} MB 以內`
}

/** 檔案大小的顯示字（MB、一位小數）：`25.0 MB`。 */
function sizeText(bytes: number): string {
  return `${(bytes / MIB).toFixed(1)} MB`
}

/**
 * 預檢一個檔：合格回 null，不合格回要寫在欄位下的那一句。類型先檢查（傳錯類型時大小沒有意義）。
 * 類型看副檔名（瀏覽器給的 MIME 不可靠）；偽裝副檔名的檔由伺服器看內容擋。
 */
export function checkPickedFile(file: { readonly name: string; readonly size: number }, rules: FileRules): string | null {
  const dot = file.name.lastIndexOf('.')
  const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : ''
  const allowed = rules.allowedTypes.some((t) => extensionsOf(t).includes(ext))
  if (!allowed) return `只接受 ${typesText(rules)}`
  if (file.size > rules.maxMiB * MIB) return `超過 ${rules.maxMiB} MB 上限（這個檔 ${sizeText(file.size)}）`
  return null
}
