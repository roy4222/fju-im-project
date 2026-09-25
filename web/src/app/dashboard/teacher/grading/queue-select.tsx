'use client'

/**
 * 手機寬度的選組下拉（票 37；原型評分工作台在窄螢幕把左側清單收成一個 `<select>`）。
 *
 * 換組用整頁導向（`location.assign`），不是用 client 端路由：評分表還有沒暫存的輸入時，
 * 瀏覽器的「離開此頁？」提示（評分表掛的 beforeunload）才會跳出來，跟重新整理、關分頁一樣受保護。
 */
export function QueueSelect({
  options,
  value,
}: {
  options: readonly { value: string; href: string; label: string }[]
  value: string
}) {
  return (
    <label className="flex flex-col gap-1.5 lg:hidden">
      <span className="text-xs font-semibold text-muted-foreground">組別</span>
      <select
        value={value}
        onChange={(e) => {
          const next = options.find((o) => o.value === e.target.value)
          if (next) window.location.assign(next.href)
        }}
        className="tabular h-11 rounded-lg border border-input bg-card px-3 text-sm font-semibold outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}
