'use client'
import Link from 'next/link'
import { useState } from 'react'
import { IconDownload, IconFile, IconFileText, IconFolders, IconPhoto, IconPresentation, IconSearch, IconX } from '@tabler/icons-react'
import { Panel, Pill, pillClass } from '@/app/_ui/dashboard-kit'
import { cn } from '@/shared/cn'

/**
 * 檔案管理的表格（票 35；原型 `files/files-table.tsx`＋`data-table`）：搜尋檔名、依類型篩、
 * 每列下載（走 `/api/files/<id>`，每次重新授權）與引用位置。
 *
 * 跟原型不同：沒有「上傳資源」與「刪除」——檔案一定掛在某個專題事務、繳交或名單上，
 * 權限跟著那一筆走；獨立上傳與軟刪除屬於「檔案工作台／檔案回收」（開發計畫第 6 節，之後再做）。
 * 被引用的檔案照原型給「去解除引用」的方向（附件、封面進編輯器改）。
 */

export type FileKind = 'item' | 'submission' | 'other'

export type FileRowView = {
  id: string
  name: string
  kind: FileKind
  kindLabel: string
  whereText: string
  whereHref: string | null
  /** 附件、封面：解除引用要回編輯器改。 */
  releaseHref: string | null
  uploader: string
  size: string
  date: string
  refs: number
}

const KIND_FILTERS: { key: FileKind | 'all'; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'item', label: '公告與資源附件' },
  { key: 'submission', label: '繳交檔案' },
  { key: 'other', label: '其他' },
]

function FileIcon({ name }: { name: string }) {
  const lower = name.toLowerCase()
  const cls = 'size-4 shrink-0 text-muted-foreground'
  if (lower.endsWith('.pdf')) return <IconFileText aria-hidden className={cls} />
  if (lower.endsWith('.pptx')) return <IconPresentation aria-hidden className={cls} />
  if (/\.(jpe?g|png)$/.test(lower)) return <IconPhoto aria-hidden className={cls} />
  return <IconFile aria-hidden className={cls} />
}

export function FilesTable({ rows, initialKind }: { rows: readonly FileRowView[]; initialKind: FileKind | 'all' }) {
  const [kind, setKind] = useState<FileKind | 'all'>(initialKind)
  const [q, setQ] = useState('')
  const query = q.trim().toLowerCase()
  const shown = rows.filter((r) => (kind === 'all' || r.kind === kind) && (!query || r.name.toLowerCase().includes(query)))
  const filtered = kind !== 'all' || query !== ''

  return (
    <Panel title="檔案" icon={<IconFolders />} bodyClassName="p-4">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative block max-sm:w-full">
            <span className="sr-only">搜尋檔名</span>
            <IconSearch aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜尋檔名"
              className="h-9 w-full rounded-lg border border-input bg-background pr-3 pl-8 text-sm outline-none transition-[border-color,box-shadow] focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/25 sm:w-72"
            />
          </label>
          <div role="group" aria-label="類型" className="flex flex-wrap gap-1">
            {KIND_FILTERS.map((k) => (
              <button key={k.key} type="button" aria-pressed={kind === k.key} onClick={() => setKind(k.key)} className={pillClass(kind === k.key)}>
                {k.label}
              </button>
            ))}
          </div>
          {filtered ? (
            <button
              type="button"
              onClick={() => {
                setKind('all')
                setQ('')
              }}
              className="inline-flex h-9 items-center gap-1 rounded-lg px-2.5 text-sm font-semibold transition-colors hover:bg-muted"
            >
              <IconX aria-hidden className="size-4" /> 清除條件
            </button>
          ) : null}
        </div>

        <div className="relative rounded-lg border border-border">
          <div className="max-h-[32rem] overflow-auto">
            <table className="w-full min-w-[60rem] table-fixed text-sm" aria-label="檔案列表">
              <colgroup>
                <col className="w-[260px]" />
                <col className="w-[110px]" />
                <col className="w-[180px]" />
                <col className="w-[90px]" />
                <col className="w-[90px]" />
                <col className="w-[110px]" />
                <col className="w-[70px]" />
                <col className="w-[160px]" />
              </colgroup>
              <thead className="sticky top-0 z-10 bg-muted text-left text-xs text-muted-foreground">
                <tr>
                  {['檔名', '類型', '引用位置', '上傳者', '大小', '日期', '引用', '操作'].map((h) => (
                    <th key={h} scope="col" className="h-10 px-3 font-semibold whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="h-40 text-center">
                      <p className="text-sm font-medium">{filtered ? '沒有符合條件的資料' : '沒有檔案'}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {filtered ? '換個關鍵字或清除條件。' : '專題事務的附件、學生的繳交檔案上傳後會出現在這裡。'}
                      </p>
                    </td>
                  </tr>
                ) : (
                  shown.map((r) => (
                    <tr key={r.id} data-testid="file-row" className="border-t border-border transition-colors hover:bg-muted/50">
                      <td className="truncate px-3 py-2.5">
                        <span className="flex items-center gap-2 font-semibold">
                          <FileIcon name={r.name} />
                          <span className="truncate" title={r.name}>
                            {r.name}
                          </span>
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <Pill tone={r.kind === 'submission' ? 'brand' : 'default'}>{r.kindLabel}</Pill>
                      </td>
                      <td className="truncate px-3 py-2.5">
                        {r.whereHref ? (
                          <Link
                            href={r.whereHref}
                            className="block truncate text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                          >
                            {r.whereText}
                          </Link>
                        ) : (
                          <span className="block truncate text-sm text-muted-foreground">{r.whereText}</span>
                        )}
                      </td>
                      <td className="truncate px-3 py-2.5 text-sm">{r.uploader}</td>
                      <td className="truncate px-3 py-2.5 text-sm text-muted-foreground tabular-nums">{r.size}</td>
                      <td className="truncate px-3 py-2.5 text-sm text-muted-foreground tabular-nums">{r.date}</td>
                      <td className="px-3 py-2.5 text-sm tabular-nums">
                        <span className={cn(r.refs > 0 ? 'font-semibold' : 'text-muted-foreground')}>{r.refs}</span>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="flex items-center gap-1">
                          <a
                            href={`/api/files/${r.id}`}
                            aria-label={`下載 ${r.name}`}
                            className="inline-flex size-7 items-center justify-center rounded-md transition-colors hover:bg-muted"
                          >
                            <IconDownload aria-hidden className="size-4" />
                          </a>
                          {r.refs > 0 ? (
                            <span className="text-[11px] leading-tight text-muted-foreground" title="被引用的檔案不能刪">
                              {r.releaseHref ? (
                                <Link href={r.releaseHref} className="underline underline-offset-2 hover:text-foreground">
                                  去解除引用
                                </Link>
                              ) : (
                                '被引用'
                              )}
                            </span>
                          ) : null}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
        <p className="text-xs text-muted-foreground tabular-nums">
          {filtered ? `符合 ${shown.length} 筆・共 ${rows.length} 筆` : `共 ${rows.length} 筆`}
        </p>
      </div>
    </Panel>
  )
}
