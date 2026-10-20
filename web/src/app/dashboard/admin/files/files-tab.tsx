import Link from 'next/link'
import type { FileListRow } from '@/application/ops'
import { FilesTable } from '@/app/dashboard/admin/files/files-table'
import { fileRowView, type FileKind } from '@/app/dashboard/admin/files/files-view'

/**
 * 「公告與作業 › 檔案」分頁的內容（C1-16；①設計方案 §4.6）：說明列＋檔案表。
 *
 * 這一頁不上傳（N-138；待問 Q7）：檔案都掛在公告、資源、作業底下，新增要到編輯器夾帶附件。
 * 沒有地方在用的檔可以在表格裡刪（`deleteUnreferenced`，§1.6）。
 */
export function FilesTab({ rows, initialKind }: { rows: readonly FileListRow[]; initialKind: FileKind | 'all' }) {
  return (
    <>
      <p data-testid="files-add-hint" className="dash-card flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-sm text-muted-foreground">
        <span className="min-w-0 flex-1">要新增檔案，去「公告與作業」的編輯器加附件。沒有地方在用的檔案可以在這裡刪除。</span>
        <Link href="/dashboard/admin/editor/new" className="shrink-0 font-semibold text-primary-on-subtle hover:underline">
          去編輯器
        </Link>
      </p>
      <FilesTable rows={rows.map(fileRowView)} initialKind={initialKind} />
    </>
  )
}
