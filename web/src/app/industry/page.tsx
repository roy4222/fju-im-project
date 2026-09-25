import Link from 'next/link'
import type { Metadata } from 'next'
import { IconArrowRight, IconBriefcase, IconBuilding, IconUser } from '@tabler/icons-react'
import type { OpportunityCard } from '@/application/groups'
import { currentActor, requireSignedIn } from '@/app/_ui/guard'
import { ListEmpty, NeedLogin, PillLink, PublicPage, SearchField, Tag } from '@/app/_ui/public-content'
import { SiteShell } from '@/app/_ui/site-shell'
import { getOpportunityQuery } from '@/composition/groups'
import { formatTaipeiDate, taipeiDateOf } from '@/shared/time'
import { SortSelect } from './sort-select'

export const metadata: Metadata = {
  title: '產學合作｜資管系專題平台',
  robots: { index: false },
  alternates: { canonical: '/industry' },
}

const one = (value: string | string[] | undefined) => (typeof value === 'string' ? value : '')

type Linked = '' | 'open' | 'linked'
type Sort = 'newest' | 'oldest' | 'company'
const SORT_LABEL: Record<Sort, string> = { newest: '發布日期（新到舊）', oldest: '發布日期（舊到新）', company: '公司名稱' }

function OpportunityCardView({ card }: { card: OpportunityCard }) {
  return (
    <Link
      href={`/industry/${card.id}`}
      data-testid="opportunity-card"
      className="group flex h-full flex-col gap-3 rounded-xl border border-border bg-card p-5 transition-colors hover:border-primary sm:p-6"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary-subtle text-primary-on-subtle">
            <IconBuilding className="size-5" aria-hidden />
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="text-lg leading-tight font-bold break-words text-foreground transition-colors group-hover:text-primary">
              {card.companyName}
            </span>
            <span className="text-[13px] text-muted-foreground">{card.department}</span>
          </div>
        </div>
        {card.linkedGroupCount > 0 ? <Tag tone="ink">已有 {card.linkedGroupCount} 組</Tag> : <Tag>尚無組別</Tag>}
      </div>
      <p className="line-clamp-3 text-base leading-snug font-semibold break-words text-foreground">{card.summary}</p>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-[13px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <IconUser className="size-4" aria-hidden />
          {card.ownerName} 老師
          {card.publishedAt ? (
            <>
              <span aria-hidden>・</span>
              <span className="tabular-nums">{formatTaipeiDate(taipeiDateOf(card.publishedAt))}</span>
            </>
          ) : null}
        </span>
        <span className="inline-flex items-center gap-1 font-semibold text-ink transition-colors group-hover:text-primary">
          詳細資料 <IconArrowRight className="size-4" aria-hidden />
        </span>
      </div>
    </Link>
  )
}

/**
 * 產學合作列表（票 20；原型 `/industry`；產品 6.1）：**登入後**內容，訪客看到登入提示。
 *
 * 卡片只有公開欄位（公司、部門、內容摘要、負責老師、發布日、連結組數）；聯絡資料不在列表。
 * 篩選、搜尋、排序都在網址上、由伺服器算；看得到什麼由查詢本身依登入身分決定。
 */
export default async function IndustryPage({
  searchParams,
}: {
  searchParams: Promise<{ linked?: string | string[]; q?: string | string[]; sort?: string | string[] }>
}) {
  const actor = await currentActor()
  if (actor.kind !== 'authenticated') {
    return (
      <SiteShell current="/industry">
        <NeedLogin next="/industry" what="產學合作列表" />
      </SiteShell>
    )
  }
  // 待審、必須改密的帳號導到各自的頁面（登入了但還不能用業務功能）。
  await requireSignedIn('/industry')
  const params = await searchParams
  const linked: Linked = one(params.linked) === 'open' ? 'open' : one(params.linked) === 'linked' ? 'linked' : ''
  const sort: Sort = (['newest', 'oldest', 'company'] as const).find((s) => s === one(params.sort)) ?? 'newest'
  const q = one(params.q).trim().slice(0, 100)
  const cards = await getOpportunityQuery().list(actor, { linked: linked || undefined, q: q || undefined, sort })
  const link = (patch: { linked?: Linked; q?: string; sort?: Sort }) => {
    const merged = { linked, q, sort, ...patch }
    const next = new URLSearchParams()
    if (merged.linked) next.set('linked', merged.linked)
    if (merged.q) next.set('q', merged.q)
    if (merged.sort !== 'newest') next.set('sort', merged.sort)
    const s = next.toString()
    return `/industry${s ? `?${s}` : ''}`
  }
  const filtered = Boolean(linked || q)

  return (
    <SiteShell current="/industry" bare>
      <PublicPage
        title="產學合作"
        description="老師建立的合作案。產學組的組長可以在「我的組別」把組別連結到合作案。"
        className="flex flex-col gap-6"
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <nav aria-label="連結狀態" className="flex flex-wrap gap-2">
            {(
              [
                ['', '全部'],
                ['open', '尚無組別'],
                ['linked', '已有組別'],
              ] as const
            ).map(([value, label]) => (
              <PillLink key={value || 'all'} href={link({ linked: value })} active={value === linked}>
                {label}
              </PillLink>
            ))}
          </nav>
          <SearchField
            action="/industry"
            id="industry-q"
            label="搜尋合作案"
            placeholder="搜尋公司、部門、內容、老師"
            defaultValue={q}
            keep={{ linked }}
          >
            <SortSelect id="industry-sort" defaultValue={sort} options={Object.entries(SORT_LABEL)} />
          </SearchField>
        </div>

        {cards.length === 0 ? (
          <ListEmpty
            icon={<IconBriefcase className="size-9" aria-hidden />}
            title={filtered ? '找不到符合的合作案' : '目前沒有發布中的合作案'}
            hint={filtered ? '換個關鍵字，或清除篩選條件。' : '老師建立並發布合作案後會出現在這裡。'}
            clearHref={filtered ? '/industry' : undefined}
          />
        ) : (
          <ul className="grid gap-5 md:grid-cols-2">
            {cards.map((card) => (
              <li key={card.id}>
                <OpportunityCardView card={card} />
              </li>
            ))}
          </ul>
        )}
        <p className="text-[13px] text-muted-foreground">共 {cards.length} 件合作案。公司聯絡資料只有負責老師與系辦看得到；學生請透過指導老師聯繫。</p>
      </PublicPage>
    </SiteShell>
  )
}
