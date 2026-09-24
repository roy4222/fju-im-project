import Link from 'next/link'
import type { Metadata } from 'next'
import { currentActor } from '@/app/_ui/guard'
import { AttachmentList, ListEmpty, NeedLogin, PublicPageHead, publishedDate } from '@/app/_ui/public-content'
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
    <SiteShell current="/files">
      <PublicPageHead title="檔案下載" description="系辦發布的範本、格式與附件。每次下載都會重新確認你能不能拿這個檔。" />
      <div className="grid gap-8 lg:grid-cols-[12rem_minmax(0,1fr)]">
        <aside>
          <p className="text-xs font-semibold tracking-wider text-muted-foreground">分類</p>
          <nav aria-label="檔案分類" className="mt-2 flex flex-col gap-1">
            {['', ...categories].map((c) => (
              <Link
                key={c || 'all'}
                href={href(c)}
                aria-current={c === category ? 'true' : undefined}
                className={cn(
                  'rounded-md px-3 py-2 text-sm',
                  c === category ? 'bg-primary-subtle font-semibold text-primary-on-subtle' : 'text-ink hover:bg-muted',
                )}
              >
                {c || '全部'}
              </Link>
            ))}
          </nav>
        </aside>
        <div className="flex min-w-0 flex-col gap-6">
          <form action="/files" role="search" className="flex max-w-sm gap-2">
            {category ? <input type="hidden" name="category" value={category} /> : null}
            <label htmlFor="files-q" className="sr-only">
              搜尋資源
            </label>
            <input
              id="files-q"
              name="q"
              defaultValue={q}
              placeholder="搜尋資源標題"
              className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-sm"
            />
            <button type="submit" className="h-9 rounded-md bg-muted px-3 text-sm font-medium text-ink hover:bg-border">
              搜尋
            </button>
          </form>
          {resources.length === 0 ? (
            <ListEmpty
              title={q || category ? '找不到符合的資源' : '目前還沒有可下載的資源'}
              hint={q || category ? '換個關鍵字，或清除篩選條件。' : '系辦發布範本或參考文件後會出現在這裡。'}
              clearHref={q || category ? '/files' : undefined}
            />
          ) : (
            groups.map((g) => (
              <section key={g.name} aria-label={g.name} className="flex flex-col gap-3">
                <h2 className="text-lg font-semibold text-ink">{g.name}</h2>
                <ul className="flex flex-col gap-3">
                  {g.items.map((r) => (
                    <li key={r.id} data-testid="resource" className="rounded-card border border-border p-4">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <h3 className="text-base font-semibold text-ink">{r.title}</h3>
                        <span className="text-xs text-muted-foreground tabular-nums">{publishedDate(r)}</span>
                      </div>
                      {r.summary ? <p className="mt-1 text-sm text-muted-foreground">{r.summary}</p> : null}
                      <div className="mt-3">
                        {r.attachments.length > 0 ? (
                          <AttachmentList files={r.attachments} label={`${r.title} 的檔案`} />
                        ) : (
                          <p className="text-sm text-muted-foreground">這一項沒有附檔。</p>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </div>
    </SiteShell>
  )
}
