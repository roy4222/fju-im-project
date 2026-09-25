import Link from 'next/link'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { cache } from 'react'
import { IconLock, IconPlayerPlay } from '@tabler/icons-react'
import { currentActor } from '@/app/_ui/guard'
import { CoverImage, fileImage, ToneTag } from '@/app/_ui/public-blocks'
import { GoneNotice } from '@/app/_ui/public-content'
import { SiteShell } from '@/app/_ui/site-shell'
import { getPublicShowcaseQuery } from '@/composition/showcase'

/** 同一個請求裡 metadata 與頁面共用一次查詢。 */
const load = cache(async (id: string) => getPublicShowcaseQuery().entry(await currentActor(), id))

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params
  const page = await load(id)
  // 看不到內容的狀態（已下架、找不到）不在標題裡露出原本的題目。
  if (page.access !== 'visible') return { title: '專題作品｜資管系專題平台', robots: { index: false } }
  return {
    title: `${page.item.title}｜資管系專題平台`,
    description: page.item.summary.slice(0, 160) || undefined,
    alternates: { canonical: `/projects/${id}` },
    openGraph: { url: `/projects/${id}` },
  }
}

/**
 * 專題詳情（原型 `/projects/[id]`；產品模組 09「訪客看摘要、海報預覽與影片入口，組員與老師登入後顯示」、SHW-03）。
 *
 * 已發布的作品任何人都看得到白名單欄位；組員與指導老師只給登入者（查詢層就不給訪客，不是畫面藏起來）。
 * 撤稿的告訴他已下架（SHW-06），草稿與不存在一律 404。
 */
export default async function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const page = await load(id)
  if (page.access === 'not_found') notFound()
  if (page.access === 'withdrawn') {
    return (
      <SiteShell current="/projects/featured">
        <GoneNotice kind="archived" what="作品" back={{ href: '/projects/featured', label: '看其他優秀專題' }} />
      </SiteShell>
    )
  }

  const { item, people, prev, next } = page
  const member = people !== null
  const backHref = member ? '/projects' : '/projects/featured'
  const backLabel = member ? '歷屆專題一覽' : '優秀專題'
  const image = fileImage(item.posterFileId)
  const facts: [string, string][] = member
    ? [
        ['屆別', `${item.cohortCode} 屆`],
        ['組別', item.groupCode ?? '（歷屆補登）'],
        ['指導老師', people.advisorName ?? '（未指派）'],
        ['組員', people.memberNames.length ? people.memberNames.join('、') : '（未補登）'],
      ]
    : [
        ['屆別', `${item.cohortCode} 屆${item.groupCode ? `・${item.groupCode}` : ''}`],
        ['組員與老師', '登入後顯示'],
      ]

  return (
    <SiteShell current={member ? '/projects' : '/projects/featured'} bare>
      <div className="mx-auto grid max-w-6xl gap-12 px-5 py-10 lg:grid-cols-[minmax(0,1fr)_340px]">
        <article className="flex min-w-0 flex-col gap-5">
          <nav aria-label="麵包屑" className="text-[13px] text-muted-foreground">
            <Link href="/" className="hover:text-foreground">
              首頁
            </Link>
            {' › '}
            <Link href={backHref} className="hover:text-foreground">
              {backLabel}
            </Link>
            {` › ${item.cohortCode} 屆`}
          </nav>
          <div className="flex flex-wrap gap-2">
            <ToneTag tone="navy">{item.cohortCode} 屆</ToneTag>
            {item.groupCode ? <ToneTag tone="navy">{item.groupCode}</ToneTag> : null}
          </div>
          <h1 className="text-[26px] leading-snug font-extrabold text-foreground sm:text-[32px]">{item.title}</h1>
          <div className="relative aspect-video overflow-hidden rounded-xl bg-muted">
            <CoverImage src={image} />
            {item.videoUrl ? (
              <>
                <a
                  href={item.videoUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="absolute top-1/2 left-1/2 inline-flex size-18 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-background/92 text-primary shadow-lg transition-transform hover:scale-105"
                  aria-label="播放三分鐘影片（另開新視窗）"
                >
                  <IconPlayerPlay className="size-7" />
                </a>
                <span className="absolute bottom-4 left-4 rounded bg-black/60 px-2 py-1 text-xs text-white">三分鐘影片・系上 YouTube 不公開連結</span>
              </>
            ) : null}
          </div>
          <section className="flex flex-col gap-2.5">
            <h2 className="text-xl font-bold text-ink">摘要</h2>
            <p className="text-base leading-loose whitespace-pre-line text-foreground">{item.summary || '（尚未填寫摘要）'}</p>
          </section>
          {member ? null : (
            // 訪客邊界：公開＝摘要、海報、影片入口；組員名單與老師登入後才看。
            <section className="flex flex-col gap-3 rounded-xl border border-border bg-secondary/60 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <IconLock className="mt-0.5 size-5 shrink-0 text-ink" aria-hidden />
                <div>
                  <h2 className="text-base font-bold text-ink">登入後可看完整資料</h2>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    組員名單與指導老師只提供本系學生與老師。公開的是摘要、海報預覽與影片入口。
                  </p>
                </div>
              </div>
              <Link href={`/login?next=${encodeURIComponent(`/projects/${id}`)}`} className="btn-fju h-11 shrink-0 px-6 text-[15px]">
                登入
              </Link>
            </section>
          )}
          <nav className="grid gap-4 border-t border-border pt-5 sm:grid-cols-2" aria-label="上一件與下一件">
            {prev ? (
              <Link href={`/projects/${prev.id}`} className="flex flex-col gap-1 hover:text-primary">
                <span className="text-xs text-muted-foreground">‹ 上一件</span>
                <span className="font-bold">{prev.title}</span>
              </Link>
            ) : (
              <span />
            )}
            {next ? (
              <Link href={`/projects/${next.id}`} className="flex flex-col gap-1 text-right hover:text-primary">
                <span className="text-xs text-muted-foreground">下一件 ›</span>
                <span className="font-bold">{next.title}</span>
              </Link>
            ) : null}
          </nav>
        </article>
        <aside className="flex flex-col gap-4 lg:pt-11">
          <dl className="flex flex-col gap-3 rounded-xl bg-secondary p-5.5 text-secondary-foreground">
            {facts.map(([k, v]) => (
              <div key={k} className="flex flex-col gap-0.5">
                <dt className="text-xs text-muted-foreground">{k}</dt>
                <dd className={v === '登入後顯示' ? 'leading-relaxed font-bold text-muted-foreground' : 'leading-relaxed font-bold text-foreground'}>{v}</dd>
              </div>
            ))}
          </dl>
          {image ? (
            <figure className="flex flex-col items-center gap-2">
              <div className="relative aspect-[3/4] w-full overflow-hidden rounded-xl bg-muted">
                <CoverImage src={image} alt="成果海報" fit="contain" />
              </div>
              <figcaption className="text-[13px] text-muted-foreground">成果海報</figcaption>
            </figure>
          ) : null}
          <Link href={backHref} className="btn-fju-outline h-12 text-base">
            回到{backLabel}
          </Link>
        </aside>
      </div>
    </SiteShell>
  )
}
