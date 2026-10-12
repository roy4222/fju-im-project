/**
 * 改派與新版影響頁的「最終成績」是照分數算出來的值，不含人工更正（驗收 P-33）。這一組有生效中的更正時，
 * 標「更正前計算值」並說明之後的變化，免得系辦以為更正已經不算；沒有更正時照舊。
 * `trigger`：哪個動作會讓更正要重新確認（改派頁只有「替換」「新增」會）。
 */
export function describePreviewFinal(input: {
  readonly before: string | null
  readonly after: string | null
  readonly hasOverride: boolean
  readonly trigger?: string
}): { readonly label: string; readonly value: string; readonly note: string } {
  const before = input.before ?? '尚未完成'
  const after = input.after ?? '尚未完成'
  if (!input.hasOverride) return { label: '最終成績', value: input.before === input.after ? after : `${before} → ${after}`, note: '' }
  return {
    label: '最終成績（更正前計算值）',
    value: input.before === input.after ? `更正前 ${before}` : `更正前 ${before} → 重算後 ${after}`,
    note: `這一組已有人工更正，成績表目前採更正值；這裡是更正前算出來的值。${input.trigger ?? '執行'}後更正要重新確認，確認前成績採重算後的值。`,
  }
}
