import type { Metadata } from 'next'
import { IconAward } from '@tabler/icons-react'
import { currentActor } from '@/app/_ui/guard'
import { PhotoDialogGrid, type PhotoEntry } from '@/app/_ui/photo-dialog-grid'
import { PillLink } from '@/app/_ui/pill-link'
import { fileImage, ListState, PageBand } from '@/app/_ui/public-blocks'
import { SearchSortBar } from '@/app/_ui/search-sort-bar'
import { SiteShell } from '@/app/_ui/site-shell'
import { getPublicItemQuery } from '@/composition/items'
import { taipeiDateOf } from '@/shared/time'

export const metadata: Metadata = {
  title: '榮譽榜｜資管系專題平台',
  description: '競賽得獎照片、得獎組別與獎項。',
  alternates: { canonical: '/honors' },
  openGraph: { url: '/honors' },
}

const one = (value: string | string[] | undefined) => (typeof value === 'string' ? value : '')

/**
 * 榮譽榜（原型 `/honors`；產品模組 04「榮譽／競賽：公開卡片與詳情」、09 §9.1）。
 *
 * 資料是專題事務發布位置「榮譽／競賽」（`managed_items.placement = 'honor'`）的已發布項目，
 * 走前台共用的 `PublicItemQuery`：誰看得到什麼由查詢依對象判斷（訪客只有「公開訪客」的）。
 * 卡片一格一格，點開一張圖＋文字；`?item=` 可深連結。年份照發布日（臺灣日期）分。
 */
export default async function HonorsPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string | string[]; item?: string | string[]; q?: string | string[]; sort?: string | string[] }>
}) {
  const sp = await searchParams
  const year = /^\d{4}$/.test(one(sp.year)) ? one(sp.year) : ''
  const q = one(sp.q).trim().slice(0, 100)
  const sort = one(sp.sort) === 'date-asc' ? 'date-asc' : 'date'
  const open = one(sp.item) || undefined
  const actor = await currentActor()
  const query = getPublicItemQuery()
  const [all, matched] = await Promise.all([
    query.list(actor, 'honor', { limit: 200 }),
    query.list(actor, 'honor', { q: q || undefined, order: sort === 'date-asc' ? 'oldest' : 'newest', limit: 200 }),
  ])
  const yearOf = (d: Date) => taipeiDateOf(d).slice(0, 4)
  const years = [...new Set(all.map((h) => yearOf(h.publishedAt)))].sort((a, b) => b.localeCompare(a))
  const items = year ? matched.filter((h) => yearOf(h.publishedAt) === year) : matched

  const keep = (y: string) => {
    const p = new URLSearchParams()
    if (y) p.set('year', y)
    if (q) p.set('q', q)
    if (sort !== 'date') p.set('sort', sort)
    const s = p.toString()
    return s ? `/honors?${s}` : '/honors'
  }
  const entries: PhotoEntry[] = items.map((h) => {
    const date = taipeiDateOf(h.publishedAt)
    return {
      id: h.id,
      image: fileImage(h.cover?.fileId),
      title: h.title,
      date,
      tags: [{ label: '榮譽榜' }, ...(h.category ? [{ label: h.category, tone: 'navy' as const }] : [])],
      summary: h.summary,
      facts: [...(h.category ? [{ label: '分類', value: h.category }] : []), { label: '日期', value: date }],
    }
  })
  const filtered = Boolean(year || q)

  return (
    <SiteShell current="/honors" bare>
      <PageBand title="榮譽榜" description="競賽得獎照片與得獎組別。點開卡片為一張圖片加文字；人物照不裁切。" crumbs={[{ label: '榮譽榜' }]} />
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-10">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <nav className="flex flex-wrap gap-2" aria-label="年份篩選">
            <PillLink href={keep('')} active={!year}>
              全部
            </PillLink>
            {years.map((y) => (
              <PillLink key={y} href={keep(y)} active={year === y}>
                {y}
              </PillLink>
            ))}
          </nav>
          <SearchSortBar
            placeholder="搜尋競賽、獎項、組別"
            sortOptions={[
              { value: 'date', label: '日期（新到舊）' },
              { value: 'date-asc', label: '日期（舊到新）' },
            ]}
          />
        </div>
        {entries.length === 0 ? (
          <ListState
            icon={<IconAward className="size-8" />}
            title={filtered ? '找不到符合的紀錄' : '目前還沒有榮譽紀錄'}
            hint={filtered ? '換個關鍵字，或清除篩選條件。' : '系辦發布得獎紀錄後會出現在這裡。'}
          />
        ) : (
          <PhotoDialogGrid entries={entries} columns={3} initialOpenId={open} />
        )}
      </div>
    </SiteShell>
  )
}
