import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { FileListRow } from '@/application/ops'
import { PageTitle } from '@/app/_ui/dashboard-kit'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { FilesTable, type FileKind, type FileRowView } from '@/app/dashboard/admin/files/files-table'
import { FILE_LIST_LIMIT, getFileListQuery } from '@/composition/files'
import { formatBytes } from '@/shared/format-bytes'
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

/**
 * 被引用、但不是專題事務附件也不是繳交檔案時，「用在哪裡」寫實際用途（N-87），不寫「（系統紀錄）」。
 * 這類檔案沒有可以點進去的頁面，只說它是做什麼的。
 */
const IN_USE_LABEL: Record<string, string> = {
  roster_csv: '匯入學生名單的原檔',
  advisor_csv: '批次指派指導老師的原檔',
  poster: '精選草稿素材',
  photo: '精選草稿素材',
  signoff_attachment: '簽核附件',
  export: '匯出檔',
  attachment: '專題事務附件',
}

function view(row: FileListRow): FileRowView {
  const where = row.where
  let kind: FileKind = 'other'
  let kindLabel = OTHER_LABEL[row.purpose] ?? '其他'
  let whereText = row.activeRefs > 0 ? (IN_USE_LABEL[row.purpose] ?? '其他用途') : '未引用'
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
    size: formatBytes(row.sizeBytes),
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
  const usageText = usage ? `整台主機已用 ${usage.used}／${usage.total}（${formatTaipeiMinute(usage.measuredAt)} 量測）` : '主機容量還沒量測'

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/files">
      <div className="flex flex-col gap-5">
        <PageTitle
          title="檔案管理"
          description={`${rows.length}${rows.length >= FILE_LIST_LIMIT ? '+' : ''} 個檔案・${usageText}・被引用的檔案不能刪`}
        />
        {/* 這一頁只看不上傳（N-138）：檔案都掛在公告、資源、收件底下，新增要到專題事務的編輯頁。 */}
        <p data-testid="files-add-hint" className="dash-card flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-sm text-muted-foreground">
          <span className="min-w-0 flex-1">
            這裡只列出已經上傳的檔案。要新增檔案請到專題事務：新增或編輯公告、資源、收件項目時夾帶附件，存檔後就會出現在這裡。
          </span>
          <Link href="/dashboard/admin/affairs" className="shrink-0 font-semibold text-primary-on-subtle hover:underline">
            前往專題事務
          </Link>
        </p>
        <FilesTable rows={rows.map(view)} initialKind={initialKind} />
      </div>
    </DashboardShell>
  )
}
