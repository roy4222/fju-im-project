import type { Metadata } from 'next'
import { IconCrown } from '@tabler/icons-react'
import { PhotoDialogGrid, type PhotoEntry } from '@/app/_ui/photo-dialog-grid'
import { imageSrc, ListEmpty, PillLink, PublicPageHead } from '@/app/_ui/public-content'
import { SearchSortBar } from '@/app/_ui/search-sort-bar'
import { SiteShell } from '@/app/_ui/site-shell'
import { getPublicShowcaseQuery, parseShowcaseSort, SHOWCASE_SORT_OPTIONS } from '@/composition/showcase'

export const metadata: Metadata = {
  title: '優秀專題｜資管系專題平台',
  description: '歷屆優秀專題：海報、題目與說明。',
  alternates: { canonical: '/projects/featured' },
  openGraph: { url: '/projects/featured' },
}

const one = (value: string | string[] | undefined) => (typeof value === 'string' ? value : '')

/**
 * 優秀專題（原型 `/projects/featured`；產品模組 09 §9.1「優秀專題公開」、SHW-03）。
 *
 * 公開：訪客可點開一圖一文 dialog 與完整詳情。資料只來自**已發布**精選條目的目前版本（白名單欄位），
 * 組員與老師不在這一頁（訪客「登入後顯示」，見詳情頁）。
 */
export default async function FeaturedPage({
  searchParams,
}: {
  searchParams: Promise<{ cohort?: string | string[]; item?: string | string[]; q?: string | string[]; sort?: string | string[] }>
}) {
  const sp = await searchParams
  const cohort = one(sp.cohort).slice(0, 20)
  const q = one(sp.q).trim().slice(0, 100)
  const rawSort = one(sp.sort)
  const sort = parseShowcaseSort(rawSort)
  const open = one(sp.item) || undefined
  const query = getPublicShowcaseQuery()
  const [cards, cohorts] = await Promise.all([query.featured({ cohort: cohort || undefined, q: q || undefined, sort }), query.cohorts()])

  const keep = (c: string) => {
    const p = new URLSearchParams()
    if (c) p.set('cohort', c)
    if (q) p.set('q', q)
    if (rawSort && sort !== 'cohort') p.set('sort', sort)
    const s = p.toString()
    return s ? `/projects/featured?${s}` : '/projects/featured'
  }
  const entries: PhotoEntry[] = cards.map((p) => ({
    id: p.id,
    image: imageSrc(p.id, p.posterFileId),
    title: p.title,
    tags: [{ label: `${p.cohortCode} 屆`, tone: 'ink' }, ...(p.groupCode ? [{ label: p.groupCode }] : [])],
    summary: p.summary,
    facts: [
      { label: '屆別', value: `${p.cohortCode} 屆` },
      ...(p.groupCode ? [{ label: '組別', value: p.groupCode }] : []),
      { label: '影片', value: p.videoUrl ? '有三分鐘影片（詳情頁）' : '—' },
    ],
    moreHref: `/projects/${p.id}`,
    moreLabel: '查看完整資料',
  }))
  const filtered = Boolean(cohort || q)

  return (
    <SiteShell current="/projects/featured" bare>
      <PublicPageHead
        title="優秀專題"
        description="歷屆優秀專題作品。點開卡片看海報與說明；完整摘要與影片在詳情頁。"
        crumbs={[{ label: '優秀專題' }]}
      />
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-10">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <nav className="flex flex-wrap gap-2" aria-label="屆別篩選">
            <PillLink href={keep('')} active={!cohort}>
              全部屆別
            </PillLink>
            {cohorts.map((c) => (
              <PillLink key={c} href={keep(c)} active={cohort === c}>
                {c} 屆
              </PillLink>
            ))}
          </nav>
          <SearchSortBar placeholder="搜尋題目、摘要、組別" sortOptions={SHOWCASE_SORT_OPTIONS} />
        </div>
        {entries.length === 0 ? (
          <ListEmpty
            icon={<IconCrown className="size-8" aria-hidden />}
            title={filtered ? '找不到符合的作品' : '目前還沒有優秀專題'}
            hint={filtered ? '換個關鍵字，或清除篩選條件。' : '系辦發布優秀專題後會出現在這裡。'}
            clearHref={filtered ? '/projects/featured' : undefined}
          />
        ) : (
          <PhotoDialogGrid entries={entries} initialOpenId={open} />
        )}
      </div>
    </SiteShell>
  )
}
