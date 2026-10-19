import type { MyItemRow } from '@/application/submissions'

/**
 * 交作業清單的「形式」欄（C 階段規格① §5.1；AC-16、AC-24）：檔案／表單／表單＋檔案／同意書。
 * 同意書（站內表單或下載 PDF 再上傳）一律寫「同意書」，其他看欄位：只有檔案欄＝檔案、沒有檔案欄＝表單、兩種都有＝表單＋檔案。
 * 列沒帶種類（舊的假資料）就當一般作業，沒帶欄位形式當「表單」。
 */
export function formLabel(row: Pick<MyItemRow, 'kind' | 'formType'>): '檔案' | '表單' | '表單＋檔案' | '同意書' {
  if (row.kind === 'consent_form' || row.kind === 'consent_upload') return '同意書'
  switch (row.formType) {
    case 'file':
      return '檔案'
    case 'mixed':
      return '表單＋檔案'
    default:
      return '表單'
  }
}
