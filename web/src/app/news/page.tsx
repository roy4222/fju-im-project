import type { Metadata } from 'next'
import { currentActor } from '@/app/_ui/guard'
import { ListEmpty, NewsCard, PillLink, PublicPage, SearchField } from '@/app/_ui/public-content'
import { SiteShell } from '@/app/_ui/site-shell'
import { getPublicItemQuery } from '@/composition/items'

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
    <SiteShell current="/news" bare>
      <PublicPage title="最新公告" description="專題事務、競賽資訊、活動與規則異動，依發布日期排序。" className="flex flex-col gap-8">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <nav aria-label="公告分類" className="flex flex-wrap gap-2">
            {['', ...categories].map((c) => (
              <PillLink key={c || 'all'} href={link({ category: c })} active={c === category} tone="brand">
                {c || '全部'}
              </PillLink>
            ))}
          </nav>
          <SearchField action="/news" id="news-q" label="搜尋公告" placeholder="搜尋公告" defaultValue={q} keep={{ category }} />
        </div>

        {cards.length === 0 ? (
          <ListEmpty
            title={q ? `找不到符合「${q}」的公告` : category ? '這個分類目前沒有公告' : '目前還沒有公告'}
            hint={q || category ? '換個關鍵字，或清除篩選條件。' : actor.kind === 'anonymous' ? '部分公告登入後才看得到。' : '系辦發布公告後會出現在這裡。'}
            clearHref={q || category ? '/news' : undefined}
          />
        ) : (
          <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {cards.map((card, index) => (
              <li key={card.id}>
                <NewsCard card={card} priority={index < 3} />
              </li>
            ))}
          </ul>
        )}
      </PublicPage>
    </SiteShell>
  )
}
