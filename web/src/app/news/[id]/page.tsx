import Link from 'next/link'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { cache } from 'react'
import { currentActor } from '@/app/_ui/guard'
import { AttachmentList, CleanBody, Crumbs, GoneNotice, ListItem, NeedLogin, publishedDate, Tag } from '@/app/_ui/public-content'
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
      <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_320px]">
        <article className="flex min-w-0 flex-col gap-5" aria-labelledby="news-title">
          <Crumbs
            items={[
              { href: '/news', label: '最新公告' },
              ...(item.category ? [{ href: `/news?category=${encodeURIComponent(item.category)}`, label: item.category }] : []),
            ]}
          />
          <div className="flex flex-wrap items-center gap-2.5">
            {item.category ? <Tag>{item.category}</Tag> : null}
            {item.audienceKind !== 'public' ? <Tag tone="ink">登入可見</Tag> : null}
            <time dateTime={item.publishedAt.toISOString()} className="text-[13px] font-semibold text-muted-foreground tabular-nums">
              {publishedDate(item)}
            </time>
          </div>
          <h1 id="news-title" className="text-[26px] leading-snug font-extrabold break-words text-foreground sm:text-[32px]">
            {item.title}
          </h1>
          {item.cover ? (
            <div className="aspect-video overflow-hidden rounded-xl bg-muted">
              {/* 封面走共用下載能力（每次重驗權限）。直式海報不裁切，所以用 contain。 */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/files/${item.cover.fileId}`} alt="" className="h-full w-full object-contain" />
            </div>
          ) : null}
          {item.summary ? <p className="text-[17px] leading-relaxed text-muted-foreground">{item.summary}</p> : null}
          <CleanBody html={item.bodyHtml} className="space-y-4 text-[17px]" />
          <AttachmentList files={item.attachments} />
        </article>
        <aside className="flex flex-col gap-4 lg:pt-11">
          {related.length > 0 ? (
            <>
              <h2 className="text-lg font-bold text-foreground">同分類公告</h2>
              <ul className="flex flex-col gap-4">
                {related.map((r) => (
                  <ListItem
                    key={r.id}
                    href={`/news/${r.id}`}
                    title={r.title}
                    meta={<span className="text-[13px] font-semibold text-muted-foreground tabular-nums">{publishedDate(r)}</span>}
                  />
                ))}
              </ul>
            </>
          ) : null}
          <Link href="/news" className="btn-fju-outline mt-2 h-12 text-base">
            回到公告列表
          </Link>
        </aside>
      </div>
    </SiteShell>
  )
}
