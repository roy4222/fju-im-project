import Link from 'next/link'
import type { Metadata } from 'next'
import { IconArrowRight, IconTrophy } from '@tabler/icons-react'
import { currentActor } from '@/app/_ui/guard'
import { CoverImage, fileImage, ListState, PageBand, ToneTag } from '@/app/_ui/public-blocks'
import { SearchSortBar } from '@/app/_ui/search-sort-bar'
import { SiteShell } from '@/app/_ui/site-shell'
import { getPublicItemQuery } from '@/composition/items'
import { taipeiDateOf } from '@/shared/time'

export const metadata: Metadata = {
  title: '競賽資訊｜資管系專題平台',
  description: '近期的競賽資訊與報名說明。',
  alternates: { canonical: '/competitions' },
  openGraph: { url: '/competitions' },
}

/**
 * 競賽資訊是公告的一個分類（產品模組 09 §9.2「最新公告：公告列表／競賽資訊」；
 * `PLACEMENT_HINT.news`「公告、說明會、競賽資訊」）。系辦發公告時分類填這個字，就會出現在這一頁。
 */
const COMPETITION_CATEGORY = '競賽資訊'

const one = (value: string | string[] | undefined) => (typeof value === 'string' ? value : '')

type Sort = 'newest' | 'oldest' | 'title'

/**
 * 競賽資訊（原型 `/competitions`）：分類是「競賽資訊」的已發布公告，走前台共用的 `PublicItemQuery`
 * （訪客只看到對象是公開的）。可搜尋、排序；每張卡連到公告全文（報名連結與附件在全文裡）。
 *
 * 原型依「截止日／活動日」自動分報名中、決賽／結果、已結束：公告沒有這兩個日期欄位，這一版不分（PR 列為待決）。
 */
export default async function CompetitionsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[]; sort?: string | string[] }>
}) {
  const sp = await searchParams
  const q = one(sp.q).trim().slice(0, 100)
  const sort: Sort = (['newest', 'oldest', 'title'] as const).find((s) => s === one(sp.sort)) ?? 'newest'
  const cards = await getPublicItemQuery().list(await currentActor(), 'news', {
    category: COMPETITION_CATEGORY,
    q: q || undefined,
    order: sort === 'oldest' ? 'oldest' : 'newest',
    limit: 200,
  })
  const items = sort === 'title' ? [...cards].sort((a, b) => a.title.localeCompare(b.title, 'zh-Hant')) : cards

  return (
    <SiteShell current="/competitions" bare>
      <PageBand
        title="競賽資訊"
        description="近期的競賽與報名說明。點開看公告全文、報名連結與附件。"
        crumbs={[{ href: '/news', label: '最新公告' }, { label: '競賽資訊' }]}
      />
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-10">
        <div className="flex flex-wrap items-center justify-end gap-4">
          <SearchSortBar
            placeholder="搜尋競賽名稱、內容"
            sortOptions={[
              { value: 'newest', label: '發布日（新到舊）' },
              { value: 'oldest', label: '發布日（舊到新）' },
              { value: 'title', label: '名稱' },
            ]}
          />
        </div>
        {items.length === 0 ? (
          <ListState
            icon={<IconTrophy className="size-8" />}
            title={q ? '找不到符合的競賽' : '目前沒有競賽資訊'}
            hint={q ? '換個關鍵字，或清除篩選條件。' : '系辦發布競賽資訊後會出現在這裡。'}
          />
        ) : (
          <ul className="grid gap-6 md:grid-cols-2">
            {items.map((c) => (
              <li key={c.id} id={c.id} className="scroll-mt-24">
                <article
                  data-testid="competition-card"
                  className="grid h-full overflow-hidden rounded-xl border border-border bg-card sm:grid-cols-[280px_minmax(0,1fr)]"
                >
                  <div className="relative aspect-video overflow-hidden sm:aspect-auto sm:min-h-52">
                    <CoverImage src={fileImage(c.cover?.fileId)} />
                  </div>
                  <div className="flex flex-col gap-2.5 p-6">
                    <div className="flex items-center gap-2">
                      <ToneTag tone="brand">{COMPETITION_CATEGORY}</ToneTag>
                      {c.audienceKind !== 'public' ? <ToneTag tone="navy">登入可見</ToneTag> : null}
                      <span className="tabular text-[13px] font-semibold text-muted-foreground">發布 {taipeiDateOf(c.publishedAt)}</span>
                    </div>
                    <h2 className="text-xl leading-snug font-bold text-foreground">{c.title}</h2>
                    {c.summary ? <p className="text-[15px] leading-relaxed text-muted-foreground">{c.summary}</p> : null}
                    <Link href={`/news/${c.id}`} className="mt-auto inline-flex items-center gap-1 pt-2 text-sm font-bold text-primary hover:underline">
                      競賽詳情與報名 <IconArrowRight className="size-4" />
                    </Link>
                  </div>
                </article>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SiteShell>
  )
}
