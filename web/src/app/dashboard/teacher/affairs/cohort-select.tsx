'use client'

import { usePathname, useRouter } from 'next/navigation'

export type CohortOption = { readonly cohortId: string; readonly label: string; readonly archived: boolean }

/** 空字串＝預設（進行中的屆別），網址上不帶 `?cohort=`。 */
const DEFAULT = ''

/**
 * 作業區「各組繳交」頂端的屆別下拉（A-18、Q136）：預設「進行中的屆別」，其餘是老師指導過的屆別（已封存的標「已封存」）。
 * 選擇就是網址上的 `?cohort=`，換一次頁；伺服器端自己再核對這個屆別老師有沒有指導，這裡只負責選。
 */
export function CohortSelect({ options, current }: { options: readonly CohortOption[]; current: string }) {
  const router = useRouter()
  const pathname = usePathname()
  return (
    <label className="flex h-10 items-center gap-2 text-sm">
      <span className="text-muted-foreground">屆別</span>
      <select
        value={current}
        onChange={(e) => router.push(e.target.value === DEFAULT ? `${pathname}?tab=submissions` : `${pathname}?cohort=${encodeURIComponent(e.target.value)}`)}
        className="h-10 rounded-md border border-input bg-background px-2.5 text-sm font-semibold outline-none focus-visible:border-primary"
        aria-label="選擇屆別"
        data-testid="cohort-select"
      >
        <option value={DEFAULT}>進行中的屆別</option>
        {options.map((o) => (
          <option key={o.cohortId} value={o.cohortId}>
            {o.label}
            {o.archived ? '（已封存）' : ''}
          </option>
        ))}
      </select>
    </label>
  )
}
