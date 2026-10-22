'use client'
import Link from 'next/link'
import { useRef, useState } from 'react'
import { IconDownload, IconFile, IconFileText, IconFolders, IconPhoto, IconPresentation, IconSearch, IconTrash, IconX } from '@tabler/icons-react'
import { DIALOG, Panel, Pill, pillClass } from '@/app/_ui/dashboard-kit'
import { TableScroll } from '@/app/_ui/ui/table'
import { deleteFileAction } from '@/app/dashboard/admin/files/files-actions'
import type { FileKind, FileRowView } from '@/app/dashboard/admin/files/files-view'

/**
 * 檔案分頁的表格（票 35；原型 `files/files-table.tsx`＋`data-table`）：搜尋檔名、依類型篩、
 * 每列下載（走 `/api/files/<id>`，每次重新授權）與引用位置。
 *
 * 刪除（C1-16）：沒有任何地方在用的檔可以刪（按後確認一句）；還有地方在用的，按鈕 disabled、直接寫原因
 * 「還有 N 處在用（公告「X」附件）」，附件、封面另給「去移除使用處」回編輯器改。
 * 不做獨立上傳（檔案一定掛在某個公告、作業、繳交或名單上，權限跟著那一筆走；待問 Q7）。
 */

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
  // 刪掉的列先在本機拿掉，不等重新整理回來（Server Action 成功後也會 refresh 整頁）。
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set())
  const query = q.trim().toLowerCase()
  const shown = rows.filter(
    (r) => !removed.has(r.id) && (kind === 'all' || r.kind === kind) && (!query || r.name.toLowerCase().includes(query)),
  )
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
          <TableScroll stickyFirst className="max-h-[32rem] overflow-auto">
            <table className="w-full min-w-[54rem] table-fixed text-sm" aria-label="檔案列表">
              {/* 檔名不設寬、吃剩下的；其餘固定 46rem，1280 寬側欄展開時檔名欄約 170px、不必橫捲。
                  min-w 54rem 讓手機橫捲時檔名欄仍有約 8rem（拿掉會被擠成 0），又小於 1280 的容器寬。
                  C1-16 拿掉「使用中」數字欄（刪除鈕已寫「還有 N 處在用」），那 3.5rem 給操作欄放原因。 */}
              <colgroup>
                <col />
                <col className="w-[7rem]" />
                <col className="w-[11rem]" />
                <col className="w-[5.5rem]" />
                <col className="w-[4.5rem]" />
                <col className="w-[6.5rem]" />
                <col className="w-[11.5rem]" />
              </colgroup>
              <thead className="sticky top-0 z-10 bg-muted text-left text-xs text-muted-foreground">
                <tr>
                  {['檔名', '類型', '用在哪裡', '上傳者', '大小', '日期', '操作'].map((h) => (
                    <th key={h} scope="col" className="h-10 px-3 font-semibold whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="h-40 text-center">
                      <p className="text-sm font-medium">{filtered ? '沒有符合條件的資料' : '沒有檔案'}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {filtered ? '換個關鍵字或清除條件。' : '公告與作業的附件、學生的繳交檔案上傳後會出現在這裡。'}
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
                      <td className="px-3 py-2.5">
                        <div className="flex items-start gap-1">
                          <a
                            href={`/api/files/${r.id}`}
                            aria-label={`下載 ${r.name}`}
                            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-muted"
                          >
                            <IconDownload aria-hidden className="size-4" />
                          </a>
                          <div className="flex min-w-0 flex-col items-start gap-0.5">
                            <DeleteFileButton row={r} onDeleted={() => setRemoved((prev) => new Set(prev).add(r.id))} />
                            {r.inUseText && r.releaseHref ? (
                              <Link
                                href={r.releaseHref}
                                className="px-1.5 text-[11px] leading-tight text-muted-foreground underline underline-offset-2 hover:text-foreground"
                              >
                                去移除使用處
                              </Link>
                            ) : null}
                          </div>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </TableScroll>
        </div>
        <p className="text-xs text-muted-foreground tabular-nums">
          {filtered ? `符合 ${shown.length} 筆・共 ${rows.length} 筆` : `共 ${rows.length} 筆`}
        </p>
      </div>
    </Panel>
  )
}

/**
 * 一列的「刪除」：沒人用的檔按下去先問一句再刪；還有地方在用的 disabled，按鈕上直接寫原因。
 * disabled 只是畫面提示——真的判斷在命令裡（交易裡重查引用），被硬按也只會拿到「還有 N 處在用」。
 */
function DeleteFileButton({ row, onDeleted }: { row: FileRowView; onDeleted: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const requestId = useRef('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function open() {
    // 每次打開確認視窗換一個請求編號：同一次確認按兩下只會刪一次。
    requestId.current = crypto.randomUUID()
    setError(null)
    dialog.current?.showModal()
  }

  async function confirm() {
    setBusy(true)
    setError(null)
    try {
      const result = await deleteFileAction({ fileId: row.id, requestId: requestId.current })
      if (result.ok) {
        dialog.current?.close()
        onDeleted()
      } else {
        setError(result.message)
      }
    } catch {
      setError('刪除失敗，請再試一次。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {row.inUseText ? (
        <button
          type="button"
          disabled
          onClick={open}
          title={row.inUseText}
          className="line-clamp-2 rounded-md px-1.5 py-0.5 text-left text-[11px] leading-tight text-muted-foreground disabled:cursor-not-allowed"
        >
          {row.inUseText}
        </button>
      ) : (
        <button
          type="button"
          onClick={open}
          aria-label={`刪除 ${row.name}`}
          className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs font-semibold text-destructive transition-colors hover:bg-destructive/10"
        >
          <IconTrash aria-hidden className="size-4" />
          刪除
        </button>
      )}
      <dialog ref={dialog} aria-label="刪除檔案" className={DIALOG}>
        <div className="space-y-4 p-5">
          <p className="text-sm">
            確定刪除「<span className="font-semibold break-all">{row.name}</span>」？刪除後原本的下載與預覽網址都會失效。
          </p>
          {error ? (
            <p role="alert" className="rounded-lg bg-destructive-subtle px-3 py-2 text-sm font-semibold text-destructive-on-subtle">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => dialog.current?.close()}
              className="h-9 rounded-lg border border-border bg-background px-4 text-sm font-semibold hover:bg-muted"
            >
              取消
            </button>
            <button
              type="button"
              onClick={confirm}
              disabled={busy}
              className="h-9 rounded-lg bg-destructive px-4 text-sm font-semibold text-white hover:bg-destructive/90 disabled:opacity-60"
            >
              {busy ? '刪除中…' : '刪除'}
            </button>
          </div>
        </div>
      </dialog>
    </>
  )
}
