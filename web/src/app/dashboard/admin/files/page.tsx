import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { FileListRow } from '@/application/ops'
import { PageTitle } from '@/app/_ui/dashboard-kit'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { AdminTabs } from '@/app/dashboard/admin/_tabs'
import { FilesTable, type FileKind, type FileRowView } from '@/app/dashboard/admin/files/files-table'
import { getFileListQuery } from '@/composition/files'
import { formatBytes } from '@/shared/format-bytes'
import { taipeiDateOf } from '@/shared/time'

export const metadata = { title: '檔案管理｜資管系專題平台' }

/** 「公告與作業」底下的三個分頁（設計方案 §3.2；`/affairs`、`/showcase` 用同一組）。 */
const AFFAIRS_TABS = [
  { href: '/dashboard/admin/affairs', label: '公告與作業' },
  { href: '/dashboard/admin/showcase', label: '成果展示' },
  { href: '/dashboard/admin/files', label: '檔案' },
] as const

/** 附件依所在項目的位置叫不同名字（原型「公開資源／公告附件／組別繳交」）。 */
const ATTACHMENT_LABEL: Record<string, string> = {
  news: '公告附件',
  resource: '資源附件',
  rules: '規則附件',
  submission: '作業附件',
}

const OTHER_LABEL: Record<string, string> = {
  roster_csv: '名單匯入',
  advisor_csv: '名單匯入',
  poster: '成果展示素材',
  photo: '成果展示素材',
  signoff_attachment: '同意書附件',
  export: '匯出檔',
  attachment: '附件',
  submission: '繳交檔案',
}

/**
 * 被引用、但不是公告與作業的附件也不是繳交檔案時，「用在哪裡」寫實際用途（N-87），不寫「（系統紀錄）」。
 * 這類檔案沒有可以點進去的頁面，只說它是做什麼的。
 */
const IN_USE_LABEL: Record<string, string> = {
  roster_csv: '匯入學生名單的原檔',
  advisor_csv: '批次指派指導老師的原檔',
  poster: '成果展示素材',
  photo: '成果展示素材',
  signoff_attachment: '同意書附件',
  export: '匯出檔',
  attachment: '公告與作業附件',
}

function view(row: FileListRow): FileRowView {
  const where = row.where
  let kind: FileKind = 'other'
  let kindLabel = OTHER_LABEL[row.purpose] ?? '其他'
  let whereText = row.activeRefs > 0 ? (IN_USE_LABEL[row.purpose] ?? '其他用途') : '沒有用到'
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
    whereText = row.activeRefs > 0 ? '草稿中' : '沒有用到'
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
  const rows = await getFileListQuery().list(actor)
  if (!rows) notFound()

  const wanted = (await searchParams).kind
  const initialKind: FileKind | 'all' = wanted === 'item' || wanted === 'submission' || wanted === 'other' ? wanted : 'all'

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/files">
      <div className="flex flex-col gap-5">
        <div>
          <PageTitle title="公告與作業" />
          <div className="mt-4">
            <AdminTabs label="公告與作業分頁" current="/dashboard/admin/files" items={AFFAIRS_TABS} />
          </div>
        </div>
        {/* 這一頁只看不上傳（N-138）：檔案都掛在公告、資源、作業底下，新增要到編輯器夾帶附件。 */}
        <p data-testid="files-add-hint" className="dash-card flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-sm text-muted-foreground">
          <span className="min-w-0 flex-1">要新增檔案，去「公告與作業」的編輯器加附件。</span>
          <Link href="/dashboard/admin/editor/new" className="shrink-0 font-semibold text-primary-on-subtle hover:underline">
            去編輯器
          </Link>
        </p>
        <FilesTable rows={rows.map(view)} initialKind={initialKind} />
      </div>
    </DashboardShell>
  )
}
