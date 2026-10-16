'use client'

import { useId, useState, type ReactNode } from 'react'
import { IconSearch } from '@tabler/icons-react'

/** 每一列：伺服器已經畫好的 `<li>`，加上「誰」「對象」兩欄的字（搜尋只比對這兩欄）。 */
export type AuditSearchRow = { id: string; who: string; target: string; node: ReactNode }

const fold = (s: string) => s.normalize('NFKC').toLowerCase()

/**
 * 操作紀錄的姓名搜尋（AD-15；設計方案 §3.6、AC-AD-26、Q113）。
 *
 * A 階段只過濾**已載入**的那批（近 7 天、最多 200 筆）：在瀏覽器裡做字串比對，不打伺服器、網址不變。
 * 不符合的列直接不渲染（不是藏起來），清空就全部回來。角色篩選膠囊是網址（`?role=`），兩者可以同時用。
 * 伺服器端搜尋是 B（AD-B6）。
 */
export function AuditSearch({ rows, note, emptyText }: { rows: readonly AuditSearchRow[]; note: string; emptyText: string }) {
  const [q, setQ] = useState('')
  const id = useId()
  const needle = fold(q.trim())
  const shown = needle ? rows.filter((r) => fold(r.who).includes(needle) || fold(r.target).includes(needle)) : rows

  return (
    <div className="flex flex-col">
      <div className="border-b border-border px-5 py-3">
        <label htmlFor={id} className="sr-only">
          搜尋姓名或對象
        </label>
        <div className="relative w-full sm:w-72">
          <IconSearch className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            id={id}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜尋姓名或對象"
            autoComplete="off"
            className="h-9 w-full min-w-0 rounded-lg border border-input bg-transparent py-1 pr-2.5 pl-8 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">{note}</p>
      </div>
      <ol aria-label="操作紀錄清單">
        {shown.map((r) => r.node)}
        {rows.length === 0 ? <li className="px-5 py-8 text-center text-sm text-muted-foreground">{emptyText}</li> : null}
        {rows.length > 0 && shown.length === 0 ? (
          <li className="px-5 py-8 text-center text-sm text-muted-foreground">{`找不到「${q.trim()}」；只比對「誰」與「對象」兩欄。`}</li>
        ) : null}
      </ol>
    </div>
  )
}
