/**
 * 系辦首頁歡迎列右邊那顆按鈕。還沒指定後台預設查看的屆別（或那一屆還沒排階段）時，
 * 歡迎列那句叫人先去屆別頁，按鈕就直接帶過去（驗收 P-03）；設好之後才是「審核帳號」。
 */
export function adminHeroCta(
  ctx: { readonly cohort: unknown; readonly position: unknown },
  pendingApps: number,
): { href: string; label: string } {
  if (!ctx.cohort || !ctx.position) return { href: '/dashboard/admin/cohorts', label: '前往屆別設定' }
  return { href: '/dashboard/admin/accounts?status=pending', label: `審核帳號（${pendingApps}）` }
}
