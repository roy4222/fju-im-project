'use client'
import { useMemo, useState, type HTMLAttributes, type ReactNode } from 'react'
import {
  IconArrowDown,
  IconArrowUp,
  IconChevronLeft,
  IconChevronRight,
  IconSearch,
  IconSelector,
  IconSettings,
  IconX,
} from '@tabler/icons-react'
import { Badge } from '@/app/_ui/ui/badge'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/app/_ui/ui/dropdown-menu'
import { Input } from '@/app/_ui/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/app/_ui/ui/table'
import { GHOST_BUTTON, OUTLINE_BUTTON } from '@/app/dashboard/teacher/_ui/dash'
import { cn } from '@/shared/cn'

/**
 * 老師後台的資料表（票 37；外觀照原型 `components/data-table/data-table.tsx`）：
 * 上方搜尋＋篩選＋「欄位」，表頭淡灰 sticky、可排序，底下「共 N 筆」與分頁。
 *
 * 原型用 `@tanstack/react-table`；這裡只要搜尋、篩選、排序、分頁四件事，自己寫一份，不為外觀多加套件。
 * 只在瀏覽器裡對已經載入的列排序與篩選，**不改查詢**：資料是頁面照原本的授權查好傳進來的。
 * 欄寬用 class（`w-[104px]`）不用 `style`：正式站的 CSP 會擋伺服器輸出的行內樣式。
 */

export type Column<T> = {
  id: string
  /** 表頭與「欄位」選單上的名字。 */
  label: string
  /** 欄寬 class，例如 `w-[104px]`。 */
  width?: string
  /** 有給就可以排序。 */
  sortValue?: (row: T) => string | number
  cell: (row: T) => ReactNode
  /** 預設可以在「欄位」選單裡隱藏；操作欄這種不該藏的設 false。 */
  hideable?: boolean
  /** 表頭另外要顯示的東西（例如截止日）；沒給就是 `label`。 */
  header?: ReactNode
  className?: string
}

export type Facet<T> = {
  id: string
  label: string
  options: readonly { value: string; label: string }[]
  value: (row: T) => string
}

const PAGE_SIZE = 10

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  rowProps,
  search,
  facets = [],
  emptyTitle,
  emptyHint,
  label,
  testId,
}: {
  rows: readonly T[]
  columns: readonly Column<T>[]
  rowKey: (row: T) => string
  rowProps?: (row: T) => HTMLAttributes<HTMLTableRowElement> & { 'data-testid'?: string }
  search?: { placeholder: string; text: (row: T) => string }
  facets?: readonly Facet<T>[]
  emptyTitle: string
  emptyHint?: string
  /** 表格的無障礙名字。 */
  label?: string
  testId?: string
}) {
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<Record<string, readonly string[]>>({})
  const [hidden, setHidden] = useState<readonly string[]>([])
  const [sort, setSort] = useState<{ id: string; dir: 'asc' | 'desc' } | null>(null)
  const [page, setPage] = useState(0)

  const hasFilters = query.trim() !== '' || Object.values(picked).some((v) => v.length > 0)
  const shownColumns = columns.filter((c) => !hidden.includes(c.id))

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = rows.filter((row) => {
      if (q && search && !search.text(row).toLowerCase().includes(q)) return false
      return facets.every((f) => {
        const values = picked[f.id] ?? []
        return values.length === 0 || values.includes(f.value(row))
      })
    })
    if (sort) {
      const column = columns.find((c) => c.id === sort.id)
      if (column?.sortValue) {
        const value = column.sortValue
        list = [...list].sort((a, b) => {
          const x = value(a)
          const y = value(b)
          const order = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'zh-Hant')
          return sort.dir === 'asc' ? order : -order
        })
      }
    }
    return list
  }, [rows, query, picked, sort, columns, facets, search])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const current = Math.min(page, pageCount - 1)
  const pageRows = filtered.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE)

  function reset() {
    setQuery('')
    setPicked({})
    setPage(0)
  }

  function toggleSort(id: string) {
    setSort((s) => (s?.id !== id ? { id, dir: 'asc' } : s.dir === 'asc' ? { id, dir: 'desc' } : null))
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {search ? (
          <div className="relative w-full sm:w-72">
            <IconSearch className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setPage(0)
              }}
              placeholder={search.placeholder}
              aria-label={search.placeholder}
              className="h-9 w-full pl-8"
            />
          </div>
        ) : null}

        {facets.map((facet) => {
          const selected = picked[facet.id] ?? []
          return (
            <DropdownMenu key={facet.id}>
              <DropdownMenuTrigger
                render={
                  <button type="button" className={OUTLINE_BUTTON}>
                    {facet.label}
                    {selected.length > 0 ? (
                      <Badge variant="outline" className="ml-1 text-[10px]">
                        {selected.length}
                      </Badge>
                    ) : null}
                  </button>
                }
              />
              <DropdownMenuContent align="start" className="w-48">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{facet.label}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {facet.options.map((opt) => (
                    <DropdownMenuCheckboxItem
                      key={opt.value}
                      checked={selected.includes(opt.value)}
                      onCheckedChange={(checked) => {
                        const next = checked ? [...selected, opt.value] : selected.filter((v) => v !== opt.value)
                        setPicked((p) => ({ ...p, [facet.id]: next }))
                        setPage(0)
                      }}
                    >
                      {opt.label}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )
        })}

        {hasFilters ? (
          <button type="button" onClick={reset} className={cn(GHOST_BUTTON, 'gap-1')}>
            <IconX /> 清除條件
          </button>
        ) : null}

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button type="button" className={cn(OUTLINE_BUTTON, 'ml-auto')} aria-label="顯示欄位">
                <IconSettings />
                <span className="hidden sm:inline">欄位</span>
              </button>
            }
          />
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuGroup>
              <DropdownMenuLabel>顯示欄位</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {columns
                .filter((c) => c.hideable !== false)
                .map((c) => (
                  <DropdownMenuCheckboxItem
                    key={c.id}
                    checked={!hidden.includes(c.id)}
                    onCheckedChange={(v) => setHidden((h) => (v ? h.filter((x) => x !== c.id) : [...h, c.id]))}
                  >
                    {c.label}
                  </DropdownMenuCheckboxItem>
                ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="relative rounded-lg border border-border">
        <div className="max-h-[32rem] overflow-auto">
          <Table className="w-full table-fixed" aria-label={label} data-testid={testId}>
            <TableHeader className="sticky top-0 z-10 bg-muted">
              <TableRow>
                {shownColumns.map((c) => {
                  const sorted = sort?.id === c.id ? sort.dir : null
                  return (
                    <TableHead key={c.id} scope="col" className={cn('whitespace-nowrap', c.width)}>
                      {c.sortValue ? (
                        <button
                          type="button"
                          onClick={() => toggleSort(c.id)}
                          className="inline-flex max-w-full items-center gap-1 rounded font-medium hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                          <span className="min-w-0 truncate">{c.header ?? c.label}</span>
                          {sorted === 'asc' ? (
                            <IconArrowUp className="size-3.5 shrink-0" />
                          ) : sorted === 'desc' ? (
                            <IconArrowDown className="size-3.5 shrink-0" />
                          ) : (
                            <IconSelector className="size-3.5 shrink-0 opacity-50" />
                          )}
                        </button>
                      ) : (
                        (c.header ?? c.label)
                      )}
                    </TableHead>
                  )
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={shownColumns.length} className="h-40 text-center">
                    {hasFilters ? (
                      <div className="space-y-1">
                        <p className="text-sm font-medium">沒有符合條件的資料</p>
                        <p className="text-xs text-muted-foreground">試著放寬搜尋字詞或清除篩選條件。</p>
                        <button type="button" onClick={reset} className={cn(OUTLINE_BUTTON, 'mt-2')}>
                          清除條件
                        </button>
                      </div>
                    ) : (
                      <div className="space-y-1 whitespace-normal">
                        <p className="text-sm font-medium">{emptyTitle}</p>
                        {emptyHint ? <p className="text-xs text-muted-foreground">{emptyHint}</p> : null}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ) : (
                pageRows.map((row) => (
                  <TableRow key={rowKey(row)} {...rowProps?.(row)}>
                    {shownColumns.map((c) => (
                      <TableCell key={c.id} className={cn('truncate', c.className)}>
                        {c.cell(row)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="tabular text-xs text-muted-foreground">共 {filtered.length} 筆</p>
        <div className="flex items-center gap-2">
          <span className="tabular text-xs text-muted-foreground">
            第 {current + 1} / {pageCount} 頁
          </span>
          <button
            type="button"
            aria-label="上一頁"
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
            className={cn(OUTLINE_BUTTON, 'size-9 px-0')}
          >
            <IconChevronLeft />
          </button>
          <button
            type="button"
            aria-label="下一頁"
            disabled={current >= pageCount - 1}
            onClick={() => setPage(current + 1)}
            className={cn(OUTLINE_BUTTON, 'size-9 px-0')}
          >
            <IconChevronRight />
          </button>
        </div>
      </div>
    </div>
  )
}
