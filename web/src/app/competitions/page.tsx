import Link from 'next/link'
import type { Metadata } from 'next'
import { IconArrowRight, IconTrophy } from '@tabler/icons-react'
import { currentActor } from '@/app/_ui/guard'
import { imageSrc, ListEmpty, PillLink, PublicPageHead, Tag } from '@/app/_ui/public-content'
import { SearchSortBar } from '@/app/_ui/search-sort-bar'
import { SiteShell } from '@/app/_ui/site-shell'
import type { CompetitionStatus } from '@/application/items'
import { getBusinessClock } from '@/composition/cohorts'
import { COMPETITION_CATEGORY, competitionStatus, getPublicItemQuery } from '@/composition/items'
import { taipeiDateOf } from '@/shared/time'

export const metadata: Metadata = {
  title: '競賽資訊｜資管系專題平台',
  description: '進行中與近期的競賽資訊、報名說明與本系參賽紀錄。',
  alternates: { canonical: '/competitions' },
  openGraph: { url: '/competitions' },
}

const one = (value: string | string[] | undefined) => (typeof value === 'string' ? value : '')

type Sort = 'deadline' | 'deadline-asc' | 'title'

/** 狀態 pill 與卡片標籤（原型 `STATUS`）：報名中橘、其他深藍。 */
const STATUS: Record<CompetitionStatus, { label: string; tone: 'brand' | 'ink' }> = {
  open: { label: '報名中', tone: 'brand' },
  result: { label: '決賽／結果', tone: 'ink' },
  closed: { label: '已結束', tone: 'ink' },
}
const STATUS_ORDER: Record<CompetitionStatus, number> = { open: 0, result: 1, closed: 2 }
const isStatus = (value: string): value is CompetitionStatus => value in STATUS

/**
 * 競賽資訊（原型 `/competitions`）：分類是「競賽資訊」的已發布公告，走前台共用的 `PublicItemQuery`
 * （訪客只看到對象是公開的）。每張卡連到公告全文（報名連結與附件在全文裡）。
 *
 * 狀態由日期推導（原型 `competitionStatus`、Roy 2026-09-08）：系辦在編輯器填報名截止日與活動日（0011，票 39），
 * 截止日（含）以前＝報名中、活動日（含）以前＝決賽／結果、都過了＝已結束；「今天」是業務時間的臺灣日期。
 * 兩個日期都沒填的舊公告沒有狀態：只出現在「全部」、排在最後。
 */
export default async function CompetitionsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[]; sort?: string | string[]; status?: string | string[] }>
}) {
  const sp = await searchParams
  const q = one(sp.q).trim().slice(0, 100)
  const sort: Sort = (['deadline', 'deadline-asc', 'title'] as const).find((s) => s === one(sp.sort)) ?? 'deadline'
  const status = isStatus(one(sp.status)) ? (one(sp.status) as CompetitionStatus) : null
  const today = taipeiDateOf(await getBusinessClock().now())
  // 狀態篩選在查詢裡做（先篩再取 200 筆）：較早發布但還在報名中的競賽不會被截掉。
  const cards = await getPublicItemQuery().list(await currentActor(), 'news', {
    category: COMPETITION_CATEGORY,
    q: q || undefined,
    limit: 200,
    competition: status ? { today, statuses: [status] } : undefined,
  })
  // 沒填截止日的用發布日排（舊公告、只填活動日的）。
  const deadlineOf = (c: (typeof cards)[number]) => c.registrationDeadline ?? c.eventDate ?? taipeiDateOf(c.publishedAt)
  const withStatus = cards.map((c) => ({ ...c, status: competitionStatus(c, today) }))
  const filtered = status ? withStatus.filter((c) => c.status === status) : withStatus
  const rank = (s: CompetitionStatus | null) => (s === null ? 3 : STATUS_ORDER[s])
  const items = [...filtered].sort((a, b) => {
    if (sort === 'title') return a.title.localeCompare(b.title, 'zh-Hant')
    if (sort === 'deadline-asc') return deadlineOf(a).localeCompare(deadlineOf(b))
    return rank(a.status) - rank(b.status) || deadlineOf(b).localeCompare(deadlineOf(a))
  })
  const keep = (patch: { status?: CompetitionStatus | null }) => {
    const p = new URLSearchParams()
    const st = 'status' in patch ? patch.status : status
    if (st) p.set('status', st)
    if (q) p.set('q', q)
    if (sort !== 'deadline') p.set('sort', sort)
    const qs = p.toString()
    return qs ? `/competitions?${qs}` : '/competitions'
  }
  const narrowed = Boolean(q || status)
  /** 卡片上的日期（原型）：報名中看截止、其他有活動日看活動日、否則看截止；都沒有就是發布日。 */
  const dateText = (c: (typeof withStatus)[number]) => {
    if (c.status === 'open' && c.registrationDeadline) return `截止 ${c.registrationDeadline}`
    if (c.eventDate) return `活動 ${c.eventDate}`
    if (c.registrationDeadline) return `截止 ${c.registrationDeadline}`
    return `發布 ${taipeiDateOf(c.publishedAt)}`
  }

  return (
    <SiteShell current="/competitions" bare>
      <PublicPageHead
        title="競賽資訊"
        description="進行中與近期的競賽。狀態依截止日與活動日自動更新；點開看公告全文、報名連結與附件。"
        crumbs={[{ href: '/news', label: '最新公告' }, { label: '競賽資訊' }]}
      />
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-10">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <nav className="flex flex-wrap gap-2" aria-label="狀態篩選">
            <PillLink href={keep({ status: null })} active={status === null}>
              全部
            </PillLink>
            <PillLink href={keep({ status: 'open' })} active={status === 'open'} tone="brand">
              報名中
            </PillLink>
            <PillLink href={keep({ status: 'result' })} active={status === 'result'}>
              決賽／結果
            </PillLink>
            <PillLink href={keep({ status: 'closed' })} active={status === 'closed'}>
              已結束
            </PillLink>
          </nav>
          <SearchSortBar
            placeholder="搜尋競賽名稱、內容"
            sortOptions={[
              { value: 'deadline', label: '截止日（新到舊）' },
              { value: 'deadline-asc', label: '截止日（舊到新）' },
              { value: 'title', label: '名稱' },
            ]}
          />
        </div>
        {items.length === 0 ? (
          <ListEmpty
            icon={<IconTrophy className="size-8" aria-hidden />}
            title={narrowed ? '找不到符合的競賽' : '目前沒有競賽資訊'}
            hint={narrowed ? '換個關鍵字，或清除篩選條件。' : '系辦發布競賽資訊後會出現在這裡。'}
            clearHref={narrowed ? '/competitions' : undefined}
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
                    {/* next/image 會輸出 style 屬性，被正式站 CSP 擋。 */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={imageSrc(c.id, c.cover?.fileId)} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
                  </div>
                  <div className="flex flex-col gap-2.5 p-6">
                    <div className="flex flex-wrap items-center gap-2">
                      {c.status ? (
                        <Tag tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Tag>
                      ) : (
                        <Tag tone="brand">{COMPETITION_CATEGORY}</Tag>
                      )}
                      {c.audienceKind !== 'public' ? <Tag tone="ink">登入可見</Tag> : null}
                      <span className="tabular text-[13px] font-semibold text-muted-foreground">{dateText(c)}</span>
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
