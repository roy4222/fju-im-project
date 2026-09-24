import Link from 'next/link'
import type { Metadata } from 'next'
import type { OpportunityCard } from '@/application/groups'
import { currentActor, requireSignedIn } from '@/app/_ui/guard'
import { ListEmpty, NeedLogin, PublicPageHead, Tag } from '@/app/_ui/public-content'
import { SiteShell } from '@/app/_ui/site-shell'
import { getOpportunityQuery } from '@/composition/groups'
import { cn } from '@/shared/cn'
import { formatTaipeiDate, taipeiDateOf } from '@/shared/time'

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
      className="group flex h-full flex-col gap-3 rounded-card border border-border bg-background p-5 transition-colors hover:border-primary"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base font-semibold leading-tight text-ink group-hover:text-primary">{card.companyName}</p>
          <p className="text-xs text-muted-foreground">{card.department}</p>
        </div>
        {card.linkedGroupCount > 0 ? <Tag>已有 {card.linkedGroupCount} 組</Tag> : <Tag tone="brand">尚無組別</Tag>}
      </div>
      <p className="line-clamp-3 text-sm text-ink">{card.summary}</p>
      <p className="mt-auto border-t border-border pt-3 text-xs text-muted-foreground tabular-nums">
        {card.ownerName} 老師
        {card.publishedAt ? `・${formatTaipeiDate(taipeiDateOf(card.publishedAt))} 發布` : ''}
      </p>
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
    <SiteShell current="/industry">
      <PublicPageHead title="產學合作" description="老師建立的合作案。產學組的組長可以在「我的組別」把組別連結到合作案。" />
      <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <nav aria-label="連結狀態" className="flex flex-wrap gap-2">
          {(
            [
              ['', '全部'],
              ['open', '尚無組別'],
              ['linked', '已有組別'],
            ] as const
          ).map(([value, label]) => (
            <Link
              key={value || 'all'}
              href={link({ linked: value })}
              aria-current={value === linked ? 'page' : undefined}
              className={cn(
                'rounded-full border px-3 py-1 text-sm',
                value === linked ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-ink hover:bg-muted',
              )}
            >
              {label}
            </Link>
          ))}
        </nav>
        <form action="/industry" role="search" className="flex flex-wrap gap-2">
          {linked ? <input type="hidden" name="linked" value={linked} /> : null}
          <label htmlFor="industry-q" className="sr-only">
            搜尋合作案
          </label>
          <input
            id="industry-q"
            name="q"
            defaultValue={q}
            placeholder="搜尋公司、部門、內容、老師"
            className="h-9 w-56 rounded-md border border-border bg-background px-3 text-sm"
          />
          <label htmlFor="industry-sort" className="sr-only">
            排序方式
          </label>
          <select id="industry-sort" name="sort" defaultValue={sort} className="h-9 rounded-md border border-border bg-background px-2 text-sm">
            {(Object.keys(SORT_LABEL) as Sort[]).map((s) => (
              <option key={s} value={s}>
                {SORT_LABEL[s]}
              </option>
            ))}
          </select>
          <button type="submit" className="h-9 rounded-md bg-muted px-3 text-sm font-medium text-ink hover:bg-border">
            套用
          </button>
        </form>
      </div>

      {cards.length === 0 ? (
        <ListEmpty
          title={filtered ? '找不到符合的合作案' : '目前沒有發布中的合作案'}
          hint={filtered ? '換個關鍵字，或清除篩選條件。' : '老師建立並發布合作案後會出現在這裡。'}
          clearHref={filtered ? '/industry' : undefined}
        />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {cards.map((card) => (
            <li key={card.id}>
              <OpportunityCardView card={card} />
            </li>
          ))}
        </ul>
      )}
      <p className="mt-6 text-xs text-muted-foreground">共 {cards.length} 件。公司聯絡資料只有負責老師與系辦看得到；學生請透過指導老師聯繫。</p>
    </SiteShell>
  )
}
