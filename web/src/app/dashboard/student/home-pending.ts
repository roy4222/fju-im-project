/**
 * 學生首頁問候下面那一句（驗收第 2 章 P-08）：待繳含逾期未繳；有逾期就講出來並指路找系辦補交，
 * 不能因為逾期就說「沒有待繳的東西」。
 */
export function homePendingLine(pending: number, overdue: number): string {
  if (!pending) return '「我的繳交」沒有待繳的東西。'
  if (overdue) return `「我的繳交」還有 ${pending} 件沒送出，其中 ${overdue} 件已逾期（要補交請聯絡系辦）。`
  return `「我的繳交」還有 ${pending} 件沒送出。`
}
