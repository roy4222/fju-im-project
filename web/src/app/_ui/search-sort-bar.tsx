'use client'
import { useRef, useState, useTransition } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { IconLoader2, IconSearch, IconX } from '@tabler/icons-react'
import { cn } from '@/shared/cn'

export type SortOption = { readonly value: string; readonly label: string }

/**
 * 列表共用的搜尋＋排序列（原型 `components/public/search-sort-bar.tsx`）。
 * 狀態寫進網址（`?q=`、`?sort=`），其他 searchParams（篩選 pill）原樣保留，重新整理與分享網址都不會掉。
 * 第一個排序選項是預設，選它時從網址拿掉 `sort`。
 */
export function SearchSortBar({
  placeholder = '搜尋',
  sortOptions,
  className,
}: {
  placeholder?: string
  sortOptions?: readonly SortOption[]
  className?: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const urlQ = params.get('q') ?? ''
  const [q, setQ] = useState(urlQ)
  const [seenQ, setSeenQ] = useState(urlQ)
  // 網址的 q 被別處改掉（例如點篩選 pill）時，在 render 期間同步輸入框，不用 effect。
  if (urlQ !== seenQ) {
    setSeenQ(urlQ)
    setQ(urlQ)
  }
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [pending, startTransition] = useTransition()

  function push(next: Record<string, string>) {
    const sp = new URLSearchParams(params.toString())
    for (const [k, v] of Object.entries(next)) {
      if (v) sp.set(k, v)
      else sp.delete(k)
    }
    // 換條件就回到「沒有打開任何一張」的狀態（`?item=` 是深連結用的）。
    sp.delete('item')
    const s = sp.toString()
    startTransition(() => router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false }))
  }

  function onInput(v: string) {
    setQ(v)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => push({ q: v.trim() }), 250)
  }

  const first = sortOptions?.[0]
  return (
    <div className={cn('flex flex-wrap items-center gap-2.5', className)}>
      <label className="relative flex h-10 w-full items-center sm:w-72">
        <IconSearch className="pointer-events-none absolute left-3 size-4 text-muted-foreground" aria-hidden />
        <input
          type="search"
          value={q}
          onChange={(e) => onInput(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          maxLength={100}
          className="h-10 w-full rounded-md border border-input bg-background pr-9 pl-9 text-sm shadow-xs outline-none transition-[border-color,box-shadow] duration-200 hover:border-ink/40 focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/25"
        />
        {pending ? (
          <IconLoader2 className="absolute right-2.5 size-4 animate-spin text-primary" aria-label="搜尋中" />
        ) : q ? (
          <button
            type="button"
            onClick={() => onInput('')}
            className="absolute right-2 inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
            aria-label="清除搜尋"
          >
            <IconX className="size-4" />
          </button>
        ) : null}
      </label>
      {first ? (
        <label className="flex h-10 items-center gap-2 text-sm">
          <span className="text-muted-foreground">排序</span>
          <select
            value={params.get('sort') ?? first.value}
            onChange={(e) => push({ sort: e.target.value === first.value ? '' : e.target.value })}
            className="h-10 rounded-md border border-input bg-background px-2.5 text-sm font-semibold outline-none focus-visible:border-primary"
            aria-label="排序方式"
          >
            {sortOptions!.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  )
}
