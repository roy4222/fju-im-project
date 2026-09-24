import Link from 'next/link'
import type { Metadata } from 'next'
import { currentActor } from '@/app/_ui/guard'
import { ListEmpty, NewsCard, PublicPageHead } from '@/app/_ui/public-content'
import { SiteShell } from '@/app/_ui/site-shell'
import { getPublicItemQuery } from '@/composition/items'
import { cn } from '@/shared/cn'

export const metadata: Metadata = {
  title: '最新公告｜資管系專題平台',
  description: '輔大資管系專題公告：專題事務、競賽資訊、活動與規則異動。',
  alternates: { canonical: '/news' },
}

const one = (value: string | string[] | undefined) => (typeof value === 'string' ? value : '')

/**
 * 最新公告列表（票 16；原型 `/news`；產品模組 09 §9.1）。
 *
 * 訪客只看得到對象是「公開訪客」的已發布公告；登入者多看到「登入可見」與自己對象內的公告（卡片標出來）。
 * 過濾在查詢裡做（`PublicItemQuery`），這一頁不自己判斷誰能看什麼。
 */
export default async function NewsPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string | string[]; q?: string | string[] }>
}) {
  const params = await searchParams
  const category = one(params.category).slice(0, 40)
  const q = one(params.q).slice(0, 100)
  const actor = await currentActor()
  const query = getPublicItemQuery()
  const [cards, categories] = await Promise.all([
    query.list(actor, 'news', { category: category || undefined, q: q || undefined }),
    query.categories(actor, 'news'),
  ])
  const link = (patch: { category?: string; q?: string }) => {
    const next = new URLSearchParams()
    const merged = { category, q, ...patch }
    if (merged.category) next.set('category', merged.category)
    if (merged.q) next.set('q', merged.q)
    const s = next.toString()
    return `/news${s ? `?${s}` : ''}`
  }

  return (
    <SiteShell current="/news">
      <PublicPageHead title="最新公告" description="專題事務、競賽資訊、活動與規則異動，依發布日期排序。" />
      <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <nav aria-label="公告分類" className="flex flex-wrap gap-2">
          {['', ...categories].map((c) => (
            <Link
              key={c || 'all'}
              href={link({ category: c })}
              aria-current={c === category ? 'page' : undefined}
              className={cn(
                'rounded-full border px-3 py-1 text-sm',
                c === category ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-ink hover:bg-muted',
              )}
            >
              {c || '全部'}
            </Link>
          ))}
        </nav>
        <form action="/news" role="search" className="flex gap-2">
          {category ? <input type="hidden" name="category" value={category} /> : null}
          <label htmlFor="news-q" className="sr-only">
            搜尋公告
          </label>
          <input
            id="news-q"
            name="q"
            defaultValue={q}
            placeholder="搜尋公告"
            className="h-9 w-56 rounded-md border border-border bg-background px-3 text-sm"
          />
          <button type="submit" className="h-9 rounded-md bg-muted px-3 text-sm font-medium text-ink hover:bg-border">
            搜尋
          </button>
        </form>
      </div>

      {cards.length === 0 ? (
        <ListEmpty
          title={q ? `找不到符合「${q}」的公告` : category ? '這個分類目前沒有公告' : '目前還沒有公告'}
          hint={q || category ? '換個關鍵字，或清除篩選條件。' : actor.kind === 'anonymous' ? '部分公告登入後才看得到。' : '系辦發布公告後會出現在這裡。'}
          clearHref={q || category ? '/news' : undefined}
        />
      ) : (
        <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((card) => (
            <li key={card.id}>
              <NewsCard card={card} />
            </li>
          ))}
        </ul>
      )}
    </SiteShell>
  )
}
