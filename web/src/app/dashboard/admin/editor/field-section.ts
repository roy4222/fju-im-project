/** 這些欄位在第 1 段（內容）；競賽資訊的報名截止日與活動日也畫在內容段（分類下面）。 */
const CONTENT_KEYS = new Set(['title', 'summary', 'body', 'category', 'attachments', 'cover', 'registrationDeadline', 'eventDate'])

/** 檢查表「回去補」：伺服器擋下的欄位（`field`）在編輯器的哪一段（手機切到那一個分頁）。 */
export function sectionOfField(key: string): 'content' | 'fields' | 'publish' {
  if (CONTENT_KEYS.has(key)) return 'content'
  if (key === 'fields') return 'fields'
  return 'publish'
}
