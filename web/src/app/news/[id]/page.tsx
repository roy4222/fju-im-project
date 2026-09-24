import Link from 'next/link'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { cache } from 'react'
import { currentActor } from '@/app/_ui/guard'
import { AttachmentList, CleanBody, GoneNotice, NeedLogin, publishedDate, Tag } from '@/app/_ui/public-content'
import { SiteShell } from '@/app/_ui/site-shell'
import { getPublicItemQuery } from '@/composition/items'

/** 同一個請求裡 metadata 與頁面共用一次查詢。 */
const load = cache(async (id: string) => getPublicItemQuery().open(await currentActor(), id, 'news'))

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params
  const page = await load(id)
  // 看不到內容的狀態（要登入、已下架、已撤回、找不到）不在標題裡露出原本的標題。
  if (page.access !== 'visible') return { title: '最新公告｜資管系專題平台', robots: { index: false } }
  return {
    title: `${page.item.title}｜資管系專題平台`,
    description: page.item.summary || undefined,
    alternates: { canonical: `/news/${id}` },
    robots: page.item.audienceKind === 'public' ? undefined : { index: false },
  }
}

/**
 * 公告內容頁（票 16；原型 `/news/[id]`）。
 *
 * 五種狀態照 `PublicItemQuery.open`：看得到就顯示內容（正文已經過 `renderBodyHtml`）；
 * 已下架／已撤回告知下一步（不是 404）；沒登入而對象不是公開就請他登入；其餘一律 404。
 */
export default async function NewsDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const page = await load(id)
  if (page.access === 'not_found') notFound()

  if (page.access !== 'visible') {
    return (
      <SiteShell current="/news">
        {page.access === 'need_login' ? (
          <NeedLogin next={`/news/${id}`} what="這則公告" />
        ) : (
          <GoneNotice kind={page.access} what="公告" back={{ href: '/news', label: '看其他公告' }} />
        )}
      </SiteShell>
    )
  }

  const { item } = page
  const related = item.category
    ? (await getPublicItemQuery().list(await currentActor(), 'news', { category: item.category, limit: 6 }))
        .filter((c) => c.id !== item.id)
        .slice(0, 5)
    : []

  return (
    <SiteShell current="/news">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <article className="flex min-w-0 flex-col gap-5" aria-labelledby="news-title">
          <nav aria-label="麵包屑" className="text-xs text-muted-foreground">
            <Link href="/" className="hover:text-ink">
              首頁
            </Link>
            {' › '}
            <Link href="/news" className="hover:text-ink">
              最新公告
            </Link>
            {item.category ? (
              <>
                {' › '}
                <Link href={`/news?category=${encodeURIComponent(item.category)}`} className="hover:text-ink">
                  {item.category}
                </Link>
              </>
            ) : null}
          </nav>
          <div className="flex flex-wrap items-center gap-2">
            {item.category ? <Tag>{item.category}</Tag> : null}
            {item.audienceKind !== 'public' ? <Tag tone="brand">登入可見</Tag> : null}
            <time dateTime={item.publishedAt.toISOString()} className="text-xs font-semibold text-muted-foreground tabular-nums">
              {publishedDate(item)}
            </time>
          </div>
          <h1 id="news-title" className="text-2xl font-semibold leading-snug text-ink">
            {item.title}
          </h1>
          {item.cover ? (
            <div className="aspect-video overflow-hidden rounded-card bg-muted">
              {/* 封面走共用下載能力（每次重驗權限）。 */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/files/${item.cover.fileId}`} alt="" className="h-full w-full object-contain" />
            </div>
          ) : null}
          {item.summary ? <p className="text-base text-muted-foreground">{item.summary}</p> : null}
          <CleanBody html={item.bodyHtml} />
          <AttachmentList files={item.attachments} />
        </article>
        <aside className="flex flex-col gap-3 lg:pt-8">
          {related.length > 0 ? (
            <>
              <h2 className="text-base font-semibold text-ink">同分類公告</h2>
              <ul className="space-y-3">
                {related.map((r) => (
                  <li key={r.id}>
                    <Link href={`/news/${r.id}`} className="block text-sm font-medium text-ink hover:text-primary">
                      {r.title}
                    </Link>
                    <span className="text-xs text-muted-foreground tabular-nums">{publishedDate(r)}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <Link href="/news" className="mt-2 rounded-md border-2 border-primary px-4 py-2 text-center text-sm font-semibold text-primary hover:bg-primary-subtle">
            回到公告列表
          </Link>
        </aside>
      </div>
    </SiteShell>
  )
}
