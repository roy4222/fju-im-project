import Link from 'next/link'
import type { Metadata } from 'next'
import { IconDownload, IconFileText, IconFolderOpen } from '@tabler/icons-react'
import type { ItemFileSummary, PublicItemCard } from '@/application/items'
import { currentActor } from '@/app/_ui/guard'
import { formatSize, ListEmpty, NeedLogin, PublicPage, publishedDate, SearchField } from '@/app/_ui/public-content'
import { SiteShell } from '@/app/_ui/site-shell'
import { checkStatus } from '@/composition/accounts'
import { getPublicItemQuery } from '@/composition/items'
import { cn } from '@/shared/cn'

export const metadata: Metadata = {
  title: '檔案下載｜資管系專題平台',
  robots: { index: false },
  alternates: { canonical: '/files' },
}

const one = (value: string | string[] | undefined) => (typeof value === 'string' ? value : '')

/**
 * 檔案下載（票 16；原型 `/files`；產品模組 09 §9.1「登入後才顯示的前台內容」）。
 *
 * 這一頁本身要登入（訪客看到登入提示，不是轉走）；內容是發布位置「資源下載」的項目，
 * 依看的人過濾（`PublicItemQuery`）。每個檔案的下載另外經 `/api/files/<id>` 重驗權限——
 * 對象是「公開訪客」的資源附件就算不經過這一頁也拿得到，那是下載政策的事，跟這一頁要不要登入分開。
 */
export default async function FilesPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string | string[]; q?: string | string[] }>
}) {
  const actor = await currentActor()
  if (actor.kind === 'anonymous' || checkStatus(actor, 'business')) {
    return (
      <SiteShell current="/files">
        <NeedLogin next="/files" what="檔案下載" />
      </SiteShell>
    )
  }

  const params = await searchParams
  const category = one(params.category).slice(0, 40)
  const q = one(params.q).slice(0, 100)
  const query = getPublicItemQuery()
  const [resources, categories] = await Promise.all([
    query.list(actor, 'resource', { category: category || undefined, q: q || undefined, limit: 200 }),
    query.categories(actor, 'resource'),
  ])
  const groups = [...new Set(resources.map((r) => r.category ?? '其他'))].map((name) => ({
    name,
    items: resources.filter((r) => (r.category ?? '其他') === name),
  }))
  const href = (c: string) => {
    const next = new URLSearchParams()
    if (c) next.set('category', c)
    if (q) next.set('q', q)
    const s = next.toString()
    return `/files${s ? `?${s}` : ''}`
  }

  return (
    <SiteShell current="/files" bare>
      <PublicPage title="檔案下載" description="系辦發布的範本、格式與附件。每次下載都會重新確認你能不能拿這個檔。">
        <div className="grid gap-8 lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-12">
          <aside>
            <p className="text-[13px] font-bold tracking-wider text-muted-foreground">分類</p>
            <nav aria-label="檔案分類" className="mt-2 flex flex-col gap-1">
              {['', ...categories].map((c) => (
                <Link
                  key={c || 'all'}
                  href={href(c)}
                  aria-current={c === category ? 'true' : undefined}
                  className={cn(
                    'rounded-md px-3.5 py-2.5 text-[15px] transition-colors',
                    c === category ? 'bg-primary-subtle font-bold text-primary-on-subtle' : 'text-foreground hover:bg-accent',
                  )}
                >
                  {c || '全部'}
                </Link>
              ))}
            </nav>
          </aside>
          <div className="flex min-w-0 flex-col gap-8">
            <SearchField action="/files" id="files-q" label="搜尋資源" placeholder="搜尋資源標題" defaultValue={q} keep={{ category }} inputClassName="sm:w-96" />
            {resources.length === 0 ? (
              <ListEmpty
                icon={q || category ? undefined : <IconFolderOpen className="size-9" aria-hidden />}
                title={q || category ? '找不到符合的資源' : '目前還沒有可下載的資源'}
                hint={q || category ? '換個關鍵字，或清除篩選條件。' : '系辦發布範本或參考文件後會出現在這裡。'}
                clearHref={q || category ? '/files' : undefined}
              />
            ) : (
              groups.map((g) => (
                <section key={g.name} aria-label={g.name} className="flex flex-col gap-3">
                  <h2 className="text-xl font-bold text-ink">{g.name}</h2>
                  <ul className="overflow-hidden rounded-xl border border-border">
                    {g.items.map((r) => (
                      <ResourceRow key={r.id} resource={r} />
                    ))}
                  </ul>
                </section>
              ))
            )}
          </div>
        </div>
      </PublicPage>
    </SiteShell>
  )
}

/** 下載鍵：每個檔案一顆，經 `/api/files/<id>`（每次重驗權限）。名稱帶檔名，讀得出是哪一個檔。 */
function DownloadLink({ file }: { file: ItemFileSummary }) {
  return (
    <a href={`/api/files/${file.fileId}`} aria-label={`下載 ${file.name}`} className="btn-fju h-9 shrink-0 px-3.5 text-[13px]">
      <IconDownload className="size-4" aria-hidden />
      下載
    </a>
  )
}

/**
 * 一個資源一列（原型 `/files` 的檔案列）：只有一個檔就是一列（標題、大小、日期、下載）；
 * 多個檔就在標題底下逐檔列出。
 */
function ResourceRow({ resource: r }: { resource: PublicItemCard }) {
  const single = r.attachments.length === 1 ? r.attachments[0]! : null
  return (
    <li data-testid="resource" className="flex flex-col gap-3 border-b border-border px-4 py-3.5 last:border-b-0 sm:px-5">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,1fr)_80px_100px_auto]">
        <div className="flex min-w-0 items-start gap-2.5">
          <IconFileText className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0">
            <h3 className="font-semibold break-words text-foreground">{r.title}</h3>
            {r.summary ? <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{r.summary}</p> : null}
            {single && single.name !== r.title ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{single.name}</p> : null}
            <p className="mt-0.5 text-xs text-muted-foreground tabular-nums sm:hidden">
              {publishedDate(r)}
              {single ? `・${formatSize(single.sizeBytes)}` : ''}
            </p>
          </div>
        </div>
        <span className="hidden text-sm text-muted-foreground tabular-nums sm:block">{single ? formatSize(single.sizeBytes) : ''}</span>
        <span className="hidden text-[13px] font-semibold text-muted-foreground tabular-nums sm:block">{publishedDate(r)}</span>
        {single ? (
          <DownloadLink file={single} />
        ) : r.attachments.length === 0 ? (
          <span className="text-[13px] text-muted-foreground">沒有附檔</span>
        ) : (
          <span />
        )}
      </div>
      {r.attachments.length > 1 ? (
        <ul aria-label={`${r.title} 的檔案`} className="flex flex-col divide-y divide-border rounded-lg bg-muted/50 sm:ml-7.5">
          {r.attachments.map((f) => (
            <li key={f.fileId} className="flex items-center gap-3 px-3.5 py-2">
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{f.name}</span>
              <span className="shrink-0 text-[13px] text-muted-foreground tabular-nums">{formatSize(f.sizeBytes)}</span>
              <DownloadLink file={f} />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  )
}
