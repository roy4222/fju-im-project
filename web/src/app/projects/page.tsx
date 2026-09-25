import Link from 'next/link'
import type { Metadata } from 'next'
import { IconFileText, IconPlayerPlay, IconSearchOff } from '@tabler/icons-react'
import type { SignedInShowcaseCard } from '@/application/showcase'
import { currentActor, requireSignedIn } from '@/app/_ui/guard'
import { imageSrc, ListEmpty, NeedLogin, PillLink, PublicPageHead, Tag } from '@/app/_ui/public-content'
import { SearchSortBar } from '@/app/_ui/search-sort-bar'
import { SiteShell } from '@/app/_ui/site-shell'
import { getPublicShowcaseQuery, parseShowcaseSort, SHOWCASE_SORT_OPTIONS } from '@/composition/showcase'

export const metadata: Metadata = {
  title: '歷屆專題一覽｜資管系專題平台',
  robots: { index: false },
  alternates: { canonical: '/projects' },
}

const one = (value: string | string[] | undefined) => (typeof value === 'string' ? value : '')

function ProjectCard({ project: p }: { project: SignedInShowcaseCard }) {
  const meta = [`${p.cohortCode} 屆`, p.groupCode, p.advisorName ? `指導老師 ${p.advisorName}` : null].filter(Boolean).join('・')
  return (
    <Link
      href={`/projects/${p.id}`}
      data-testid="project-card"
      className="group flex h-full flex-col overflow-hidden rounded-xl border border-border bg-card transition-[transform,box-shadow] duration-300 hover:-translate-y-0.5 hover:shadow-[0_8px_22px_rgba(0,51,102,0.14)]"
    >
      <div className="relative aspect-video overflow-hidden bg-muted">
        {/* next/image 會輸出 style 屬性，被正式站 CSP 擋。 */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageSrc(p.id, p.posterFileId)}
          alt=""
          loading="lazy"
          className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
        />
        {p.groupCode ? (
          <span className="absolute bottom-3 left-3 rounded bg-background/95 px-2 py-0.5 text-xs font-semibold text-foreground">{p.groupCode}</span>
        ) : null}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4.5">
        <span className="type-card-title text-foreground group-hover:text-primary">{p.title}</span>
        <span className="text-[13px] text-muted-foreground">{meta}</span>
        {p.summary ? <p className="line-clamp-2 text-sm leading-relaxed text-muted-foreground">{p.summary}</p> : null}
        <div className="mt-auto flex flex-wrap gap-1.5 pt-1">
          {p.posterFileId ? (
            <Tag tone="ink">
              <IconFileText className="mr-1 size-3.5" />
              海報
            </Tag>
          ) : null}
          {p.videoUrl ? (
            <Tag tone="ink">
              <IconPlayerPlay className="mr-1 size-3.5" />
              影片
            </Tag>
          ) : null}
        </div>
      </div>
    </Link>
  )
}

/**
 * 歷屆專題一覽（原型 `/projects`；產品模組 09 §9.1「登入後的學習參考庫」、SHW-04）：**登入後**內容。
 *
 * 卡片依屆別分段，多了組員與指導老師（查詢只給能正常使用平台的登入者）。
 * 資料目前和優秀專題同一批（已發布的精選條目）：兩者要分開需要「是否精選」的欄位，列為待決（見 PR）。
 */
export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ cohort?: string | string[]; q?: string | string[]; sort?: string | string[] }>
}) {
  const actor = await currentActor()
  if (actor.kind !== 'authenticated') {
    return (
      <SiteShell current="/projects">
        <NeedLogin next="/projects" what="歷屆專題一覽" />
      </SiteShell>
    )
  }
  // 待審、必須改密的帳號導到各自的頁面（登入了但還不能用業務功能）。
  await requireSignedIn('/projects')
  const sp = await searchParams
  const cohort = one(sp.cohort).slice(0, 20)
  const q = one(sp.q).trim().slice(0, 100)
  const rawSort = one(sp.sort)
  const sort = parseShowcaseSort(rawSort)
  const query = getPublicShowcaseQuery()
  const [archive, cohorts] = await Promise.all([
    query.archive(actor, { cohort: cohort || undefined, q: q || undefined, sort }),
    query.cohorts(),
  ])
  if (archive.access !== 'visible') {
    return (
      <SiteShell current="/projects">
        <NeedLogin next="/projects" what="歷屆專題一覽" />
      </SiteShell>
    )
  }
  const cards = archive.cards
  const keep = (c: string) => {
    const p = new URLSearchParams()
    if (c) p.set('cohort', c)
    if (q) p.set('q', q)
    if (rawSort && sort !== 'cohort') p.set('sort', sort)
    const s = p.toString()
    return s ? `/projects?${s}` : '/projects'
  }
  const sections =
    sort === 'title'
      ? [{ key: 'all', label: '', items: cards }]
      : [...new Set(cards.map((c) => c.cohortCode))].map((code) => ({
          key: code,
          label: `${code} 屆`,
          items: cards.filter((c) => c.cohortCode === code),
        }))
  const filtered = Boolean(cohort || q)

  return (
    <SiteShell current="/projects" bare>
      <PublicPageHead
        title="歷屆專題一覽"
        description="本系學生與老師的學習參考庫：題目、摘要、海報與三分鐘影片。"
        crumbs={[{ label: '歷屆專題一覽' }]}
      />
      <div className="mx-auto flex max-w-6xl flex-col gap-7 px-5 py-10">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
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
          <SearchSortBar placeholder="搜尋題目、組別、指導老師" sortOptions={SHOWCASE_SORT_OPTIONS} />
        </div>

        {cards.length === 0 ? (
          <ListEmpty
            icon={<IconSearchOff className="size-9" aria-hidden />}
            title={q ? `找不到符合「${q}」的作品` : filtered ? '沒有符合條件的作品' : '目前還沒有歷屆專題'}
            hint={filtered ? '換個關鍵字，或清除篩選條件。' : '系辦補登或發布作品後會出現在這裡。'}
            clearHref={filtered ? '/projects' : undefined}
          />
        ) : (
          sections.map((g) => (
            <section key={g.key} className="flex flex-col gap-5" aria-label={g.label || '全部作品'}>
              {g.label ? (
                <h2 className="flex items-center gap-4 text-xl font-bold text-ink">
                  <span className="rounded-md bg-ink px-3 py-1 text-base text-ink-foreground">{g.label}</span>
                  <span className="text-sm font-semibold text-muted-foreground">{g.items.length} 件</span>
                  <span className="h-px flex-1 bg-border" aria-hidden />
                </h2>
              ) : null}
              <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {g.items.map((p) => (
                  <li key={p.id}>
                    <ProjectCard project={p} />
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
        {cards.length > 0 ? (
          <p className="text-center text-[13px] text-muted-foreground">共 {cards.length} 件作品。影片為系上 YouTube 不公開連結。</p>
        ) : null}
      </div>
    </SiteShell>
  )
}
