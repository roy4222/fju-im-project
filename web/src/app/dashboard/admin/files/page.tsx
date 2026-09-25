import { notFound } from 'next/navigation'
import type { FileListRow } from '@/application/ops'
import { PageTitle } from '@/app/_ui/dashboard-kit'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { FilesTable, type FileKind, type FileRowView } from '@/app/dashboard/admin/files/files-table'
import { FILE_LIST_LIMIT, getFileListQuery } from '@/composition/files'
import { formatTaipeiMinute, taipeiDateOf } from '@/shared/time'

export const metadata = { title: '檔案管理｜資管系專題平台' }

/** 附件依所在項目的位置叫不同名字（原型「公開資源／公告附件／組別繳交」）。 */
const ATTACHMENT_LABEL: Record<string, string> = {
  news: '公告附件',
  resource: '公開資源',
  rules: '規則附件',
  submission: '收件附件',
}

const OTHER_LABEL: Record<string, string> = {
  roster_csv: '名單匯入',
  advisor_csv: '名單匯入',
  poster: '精選素材',
  photo: '精選素材',
  signoff_attachment: '簽核附件',
  export: '匯出檔',
  attachment: '附件',
  submission: '繳交檔案',
}

function sizeText(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function view(row: FileListRow): FileRowView {
  const where = row.where
  let kind: FileKind = 'other'
  let kindLabel = OTHER_LABEL[row.purpose] ?? '其他'
  let whereText = row.activeRefs > 0 ? '（系統紀錄）' : '未引用'
  let whereHref: string | null = null
  let releaseHref: string | null = null
  if (where?.kind === 'item_attachment' || where?.kind === 'item_cover') {
    kind = 'item'
    kindLabel = where.kind === 'item_cover' ? '封面' : (ATTACHMENT_LABEL[where.placement] ?? '附件')
    whereText = where.title
    whereHref = `/dashboard/admin/editor/${where.itemId}`
    releaseHref = whereHref
  } else if (where?.kind === 'submission') {
    kind = 'submission'
    kindLabel = '繳交檔案'
    whereText = where.title
    // 繳交檔案看收件名單頁（不能從這裡解除：正式送出的版本不可變）。
    whereHref = `/dashboard/admin/affairs/${where.itemId}`
  } else if (row.purpose === 'submission') {
    kind = 'submission'
    whereText = row.activeRefs > 0 ? '草稿中' : '未引用'
  }
  return {
    id: row.id,
    name: row.name,
    kind,
    kindLabel,
    whereText,
    whereHref,
    releaseHref,
    uploader: row.uploaderName,
    size: sizeText(row.sizeBytes),
    date: taipeiDateOf(row.uploadedAt),
    refs: row.activeRefs,
  }
}

/**
 * 檔案管理（票 35；原型 `/dashboard/admin/files`；產品模組 10「系辦在檔案管理看全部檔案、被誰引用、用量」）。
 *
 * 是同一個檔案服務的檢視，不是另一套系統：資料來自既有的 `stored_files`／`file_references`，
 * 下載一律走 `/api/files/<id>` 重新授權。上傳資源與刪除（軟刪除／回收）不在這一票（見 `files-table.tsx`）。
 */
export default async function AdminFilesPage({ searchParams }: { searchParams: Promise<{ kind?: string | string[] }> }) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole('/dashboard/admin/files', 'admin')
  const query = getFileListQuery()
  const [rows, usage] = await Promise.all([query.list(actor), query.usage(actor)])
  if (!rows) notFound()

  const wanted = (await searchParams).kind
  const initialKind: FileKind | 'all' = wanted === 'item' || wanted === 'submission' || wanted === 'other' ? wanted : 'all'
  const usageText = usage ? `用量 ${usage.used}／${usage.total}（${formatTaipeiMinute(usage.measuredAt)} 量測）` : '用量還沒量測'

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/files">
      <div className="flex flex-col gap-5">
        <PageTitle
          title="檔案管理"
          description={`${rows.length}${rows.length >= FILE_LIST_LIMIT ? '+' : ''} 個檔案・${usageText}・被引用的檔案不能刪`}
        />
        <FilesTable rows={rows.map(view)} initialKind={initialKind} />
      </div>
    </DashboardShell>
  )
}
