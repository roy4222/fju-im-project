import type { ItemStatusView } from '@/application/submissions'

/**
 * 截止欄第二行（原型）：剩幾天／今天截止／逾期幾天／已繳可重送。`daysLeft` 是臺灣日期的截止日減今天（業務時鐘）。
 * 當天截止又沒交寫「今天已截止」，不寫「逾期 0 天」（驗收第 2 章 P-07）。
 */
export function dueHint(
  daysLeft: number,
  status: Pick<ItemStatusView, 'pending' | 'submitted' | 'overdue' | 'editable'>,
): { readonly text: string; readonly cls: string } {
  const d = daysLeft
  if (status.overdue) return { text: d >= 0 ? '今天已截止' : `逾期 ${-d} 天`, cls: 'text-destructive' }
  if (status.submitted) return { text: status.editable ? `剩 ${d} 天可重送` : '已截止', cls: 'text-muted-foreground' }
  const text = d < 0 ? '已截止' : d === 0 ? '今天截止' : `剩 ${d} 天`
  return { text, cls: status.pending && d <= 10 ? 'font-semibold text-brand-on-subtle' : 'text-muted-foreground' }
}
