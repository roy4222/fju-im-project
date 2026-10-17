import Link from 'next/link'
import type { ReactNode } from 'react'
import { IconSearch } from '@tabler/icons-react'

/** 每一列：伺服器已經畫好的 `<li>`。 */
export type AuditSearchRow = { id: string; node: ReactNode }

/**
 * 操作紀錄的搜尋（AD-15、AD-B6；設計方案 §9、AC-A-32、AC-A-33、Q113）。
 *
 * 伺服器端搜尋：GET 表單（`?role=&q=`），Enter 送出，由伺服器對近 7 天的全部紀錄比對「誰」與「對象」，
 * 清單與分頁籤數字都隨搜尋字變。欄位擋在 `maxLength` 字；清除鈕是回到沒有 `q` 的網址。
 */
export function AuditSearch({
  rows,
  note,
  emptyText,
  q,
  role,
  maxLength,
  clearHref,
  error,
}: {
  rows: readonly AuditSearchRow[]
  note: string
  emptyText: string
  /** 目前生效的搜尋字（網址 `q`）；沒搜尋給空字串。 */
  q: string
  /** 目前的角色分頁（`all` 不帶進網址）。 */
  role: string
  maxLength: number
  clearHref: string
  /** 搜尋字不合格時的說明（清單改回沒有搜尋的結果）。 */
  error?: string
}) {
  return (
    <div className="flex flex-col">
      <div className="border-b border-border px-5 py-3">
        <form method="get" role="search" className="flex flex-wrap items-center gap-2">
          {role !== 'all' ? <input type="hidden" name="role" value={role} /> : null}
          <label htmlFor="audit-q" className="sr-only">
            搜尋姓名或對象
          </label>
          <div className="relative w-full sm:w-72">
            <IconSearch className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input
              id="audit-q"
              name="q"
              type="search"
              defaultValue={q}
              maxLength={maxLength}
              placeholder="搜尋姓名或對象"
              autoComplete="off"
              className="h-9 w-full min-w-0 rounded-lg border border-input bg-transparent py-1 pr-2.5 pl-8 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          </div>
          <button type="submit" className="h-9 rounded-lg border border-input px-3 text-sm font-semibold hover:bg-accent">
            搜尋
          </button>
          {q ? (
            <Link href={clearHref} className="inline-flex h-9 items-center rounded-lg px-3 text-sm font-semibold text-muted-foreground hover:bg-accent hover:text-foreground">
              清除
            </Link>
          ) : null}
        </form>
        <p className="mt-1.5 text-xs text-muted-foreground">{note}</p>
        {error ? (
          <p role="alert" className="mt-1.5 text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <ol aria-label="操作紀錄清單">
        {rows.map((r) => r.node)}
        {rows.length === 0 ? (
          <li className="px-5 py-8 text-center text-sm text-muted-foreground">
            {q ? `找不到「${q}」；只比對「誰」與「對象」兩欄。` : emptyText}
          </li>
        ) : null}
      </ol>
    </div>
  )
}
