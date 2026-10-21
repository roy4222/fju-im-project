import Link from 'next/link'
import { IconFolders } from '@tabler/icons-react'
import { Panel, Pill, pillClass } from '@/app/_ui/dashboard-kit'
import { RowActions } from '@/app/dashboard/admin/affairs/_content/list-actions'
import { AFFAIRS_TAB_PLACEMENTS, deleteBlockedText } from '@/app/dashboard/admin/affairs/affairs-view'
import { getItemQuery, ITEM_STATUS_LABEL } from '@/composition/items'
import { cn } from '@/shared/cn'

/**
 * 公告與作業 › 資源下載的清單內容（C 階段規格① §4.3；②的分頁殼掛這個元件，`{ cohortId, searchParams }`）。
 *
 * 欄：標題、分類、附件數、狀態、編輯／刪除。工具列：分類篩選（`?category=`，選項是這一屆資源用到的分類）。
 * 分類與附件數跟清單同一句查完（`ItemQuery.listWithContent`，CL-1；不逐份讀項目）。
 * 分類改名在前台「檔案下載」的分類標題上（`resource_category`，跨屆一起改）。
 */

const GRID = 'md:grid-cols-[minmax(14rem,1fr)_9rem_5rem_6rem_minmax(9rem,auto)]'
const NO_CATEGORY = '（未分類）'

function one(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export async function AffairsResourceList({
  cohortId,
  searchParams,
}: {
  cohortId: string
  searchParams: { readonly category?: string | string[] }
}) {
  const rows = await getItemQuery().listWithContent(cohortId, AFFAIRS_TAB_PLACEMENTS.resources)
  const categoryOf = (r: (typeof rows)[number]) => r.category || NO_CATEGORY
  const categories = [...new Set(rows.map(categoryOf))].sort((a, b) => a.localeCompare(b, 'zh-Hant'))
  const wanted = one(searchParams.category)
  const category = wanted && categories.includes(wanted) ? wanted : null
  const shown = category ? rows.filter((r) => categoryOf(r) === category) : rows
  const href = (value: string | null) =>
    `/dashboard/admin/affairs/resources?${new URLSearchParams({ cohort: cohortId, ...(value ? { category: value } : {}) }).toString()}`

  return (
    <Panel title="資源下載" icon={<IconFolders />}>
      {categories.length > 1 ? (
        <nav aria-label="分類" className="flex flex-wrap gap-1 border-t border-border px-5 py-3">
          <Link href={href(null)} aria-current={category === null ? 'page' : undefined} className={pillClass(category === null)}>
            全部分類
          </Link>
          {categories.map((c) => (
            <Link key={c} href={href(c)} aria-current={category === c ? 'page' : undefined} className={pillClass(category === c)}>
              {c}
            </Link>
          ))}
        </nav>
      ) : null}
      <div className={cn('hidden gap-3 border-t border-border px-5 py-2 text-xs font-semibold text-muted-foreground md:grid', GRID)} aria-hidden>
        <span>標題</span>
        <span>分類</span>
        <span>附件數</span>
        <span>狀態</span>
        <span className="text-right">動作</span>
      </div>
      <ul className="divide-y divide-border border-t border-border">
        {shown.map((r) => (
          <li key={r.id} data-testid="affair-row" className={cn('grid items-center gap-x-3 gap-y-1.5 px-5 py-3 transition-colors hover:bg-accent/40', GRID)}>
            <Link href={`/dashboard/admin/editor/${r.id}`} className="link-ink block min-w-0 truncate text-[15px] font-bold">
              {r.title}
            </Link>
            <span className="min-w-0 truncate text-xs text-muted-foreground md:text-sm">{categoryOf(r)}</span>
            <span className="text-xs tabular-nums md:text-sm" data-testid="attachment-count">
              {r.attachmentCount} 個
            </span>
            <span>
              <Pill tone={r.status === 'published' ? 'success' : 'default'}>{ITEM_STATUS_LABEL[r.status]}</Pill>
            </span>
            <RowActions
              row={{ id: r.id, title: r.title, deleteBlocked: deleteBlockedText(r.status, null, r.receiverUnit), canPin: false, pinned: false }}
            />
          </li>
        ))}
      </ul>
      {shown.length === 0 ? (
        <p className="border-t border-border px-4 py-10 text-center text-sm font-semibold">這一屆還沒有資源。按「新增」建立第一筆。</p>
      ) : null}
    </Panel>
  )
}
