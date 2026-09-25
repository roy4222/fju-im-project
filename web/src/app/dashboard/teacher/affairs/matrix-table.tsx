'use client'
import Link from 'next/link'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/app/_ui/ui/tooltip'
import { DataTable, type Column } from '@/app/dashboard/teacher/_ui/data-table'
import { Pill, type PillTone } from '@/app/dashboard/teacher/_ui/dash'

/**
 * 老師的繳交矩陣表（票 22；票 37 照原型 `TeacherMatrix`：共用資料表，一列一組、一欄一份收件，每格一個狀態標籤）。
 * 格子的狀態字與顏色由頁面在伺服器端算好（跟學生作業區、系辦名單頁同一個 `receiverStatus`），這裡只畫。
 */

export type MatrixItem = { itemId: string; title: string; due: string | null }
export type MatrixCell = { headline: string; tone: PillTone; detail: string; href: string } | null
export type MatrixRow = {
  groupId: string
  code: string
  meta: string
  members: string
  cells: Record<string, MatrixCell>
}

export function MatrixTable({ items, rows }: { items: MatrixItem[]; rows: MatrixRow[] }) {
  const columns: Column<MatrixRow>[] = [
    {
      id: 'code',
      label: '組別',
      width: 'w-[96px]',
      sortValue: (r) => r.code,
      cell: (r) => (
        <span className="tabular text-sm font-semibold" title={r.meta}>
          {r.code}
        </span>
      ),
    },
    {
      id: 'members',
      label: '組員',
      width: 'w-[220px]',
      cell: (r) => (
        <Tooltip>
          <TooltipTrigger render={<span className="block truncate text-sm">{r.members}</span>} />
          <TooltipContent className="max-w-xs">{r.members}</TooltipContent>
        </Tooltip>
      ),
    },
    ...items.map(
      (item): Column<MatrixRow> => ({
        id: item.itemId,
        label: item.title,
        width: 'w-[180px]',
        header: (
          <span className="block truncate">
            {item.title}
            {item.due ? <span className="tabular ml-1 font-normal text-muted-foreground">{item.due}</span> : null}
          </span>
        ),
        cell: (r) => {
          const cell = r.cells[item.itemId]
          if (!cell) return <span className="text-xs text-muted-foreground">不在名單</span>
          return (
            <Link href={cell.href} className="inline-flex" data-testid="matrix-cell" title={cell.detail || undefined}>
              <Pill tone={cell.tone}>{cell.headline}</Pill>
            </Link>
          )
        },
      }),
    ),
  ]

  return (
    <DataTable
      rows={rows}
      columns={columns}
      rowKey={(r) => r.groupId}
      rowProps={(r) => ({ 'data-testid': `matrix-row-${r.code}` })}
      search={{ placeholder: '搜尋組別或組員', text: (r) => `${r.code} ${r.members}` }}
      emptyTitle="沒有指導組別"
      label="繳交矩陣"
      testId="teacher-matrix"
    />
  )
}
