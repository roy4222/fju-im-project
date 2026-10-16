import Link from 'next/link'
import { cn } from '@/shared/cn'

export type TabNavItem = { readonly key: string; readonly label: string; readonly href: string }

/**
 * 老師頁的分頁列（TE-04 作業區「各組繳交｜同意書」；TE-05 分組總覽共用）。
 *
 * 分頁就是網址上的 `?tab=`：一般的 `<Link>`，不必 client 元件；目前那一頁 `aria-current="page"`。
 * 伺服器依 `?tab=` 只讀那一頁要的資料，切換分頁＝換一次頁。
 */
export function TabNav({ label, tabs, current }: { label: string; tabs: readonly TabNavItem[]; current: string }) {
  return (
    <nav aria-label={label} className="flex gap-1 border-b border-border">
      {tabs.map((tab) => {
        const active = tab.key === current
        return (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              '-mb-px inline-flex h-10 items-center border-b-2 px-3 text-sm font-semibold transition-colors',
              active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
