import Link from 'next/link'
import type { ReactNode } from 'react'
import { IconArrowRight, IconBook2, IconClock, IconKey, IconLayoutGrid, IconMail, IconTrophy, IconUpload } from '@tabler/icons-react'
import type { MyDeadline } from '@/application/items'
import { actorHasRole } from '@/composition/accounts'
import { currentActor, homeFor } from '@/app/_ui/guard'
import { AwardBadge, FirstCharAccent, imageSrc, ListEmpty, ListItem, NewsCard, Tag, publishedDate } from '@/app/_ui/public-content'
import { isMember, SiteShell } from '@/app/_ui/site-shell'
import { getBusinessClock } from '@/composition/cohorts'
import { COMPETITION_CATEGORY, competitionStatus, getPublicItemQuery } from '@/composition/items'
import { getPublicShowcaseQuery } from '@/composition/showcase'
import { getSubmissionQuery, pendingCount } from '@/composition/submissions'
import { cn } from '@/shared/cn'
import { formatTaipeiDate, taipeiDateOf } from '@/shared/time'

/**
 * 公開首頁（票 16；產品模組 09 §9.2：重要消息優先、每區幾筆再進完整列表）。
 *
 * 版型、區塊順序照原型首頁（2026-09-07 方向 A；2026-09-25 對齊）：
 * hero → [登入後：我的工作＋近期截止] → 最新公告 → [登入後：歷屆專題一覽] → 優秀專題 → 榮譽與競賽 → 快速入口。
 *
 * 最新公告、優秀專題、榮譽與競賽、學生的「我的工作／近期截止」都接真的資料（各自前台頁同一份查詢）；
 * 沒有資料的區塊才顯示空狀態（Roy 2026-09-25），
 * 那些資料做出來（開發計畫第 6 節）再接上。還沒有的頁面（優秀專題、榮譽榜、競賽、歷屆專題）不放「查看更多」。
 * 照片用原型的示意照（`public/placeholder/`）。
 */
export default async function HomePage() {
  const actor = await currentActor()
  const signedIn = actor.kind === 'authenticated'
  // 登入後的區塊（我的工作、歷屆專題、我的入口）跟導覽用同一個判斷：待審核的人跟訪客一樣。
  const member = isMember(actor)
  const home = signedIn ? homeFor(actor) : null
  const items = getPublicItemQuery()
  // 優秀專題、榮譽榜、競賽資訊：跟各自的前台頁（/projects/featured、/honors、/competitions）同一份查詢，首頁只取前幾筆。
  const [latest, featured, honors, competitions] = await Promise.all([
    items.list(actor, 'news', { limit: 6 }),
    getPublicShowcaseQuery().featured(),
    items.list(actor, 'honor', { limit: 4 }),
    items.list(actor, 'news', { category: COMPETITION_CATEGORY, limit: 30 }),
  ])
  // 競賽狀態跟 /competitions 同一個函式、同一個「今天」（業務鐘）：報名中／決賽／已結束。
  const today = taipeiDateOf(await getBusinessClock().now())
  // 「進行中的競賽」照原型先放報名中、再放決賽／結果，最後才是已結束或沒填日期的；取前 3 則。
  const rank = { open: 0, result: 1, closed: 2 } as const
  const competitionCards = competitions
    .map((c) => ({ ...c, status: competitionStatus(c, today) }))
    .sort((a, b) => (a.status ? rank[a.status] : 3) - (b.status ? rank[b.status] : 3))
    .slice(0, 3)
  // 歷屆專題一覽（登入後）：`/projects` 同一份查詢；沒開通的人查詢本身就回 need_login。
  const archive = member ? await getPublicShowcaseQuery().archive(actor) : null
  const archiveCards = archive?.access === 'visible' ? archive.cards.slice(0, 3) : []
  const [cards, rest] = [latest.slice(0, 2), latest.slice(2)]
  const work = member ? await myWork(actor) : null

  return (
    <SiteShell bare>
      {/* Hero：校園照片疊深藍漸層（系網首屏是照片，不是文字 hero）。 */}
      <section className="relative overflow-hidden bg-ink text-ink-foreground" aria-label="專題管理平台">
        {/* 靜態照片不走 next/image：它會輸出被正式站 CSP 擋的 style 屬性。 */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/placeholder/campus.jpg" alt="" className="absolute inset-0 h-full w-full object-cover opacity-55" />
        <div className="absolute inset-0 bg-gradient-to-r from-ink/95 via-ink/55 to-ink/15" aria-hidden />
        <div className="relative mx-auto flex min-h-[440px] max-w-6xl flex-col justify-center gap-5 px-5 py-16 md:min-h-[520px]">
          <span className="inline-flex items-center gap-2.5 text-[15px] font-bold tracking-widest opacity-90">
            <span className="inline-block h-0.75 w-7 bg-primary" aria-hidden />
            資訊管理學系專題
          </span>
          <h1 className="type-display max-w-2xl text-white">輔仁大學資訊管理學系專題管理平台</h1>
          <p className="max-w-lg text-[17px] leading-relaxed opacity-90">
            專題的公告、規則、名單、分組、繳交、評分與簽核都在這裡。學生用系上發的信箱或 Google 註冊，系辦核准後才會開通。
          </p>
          <div className="mt-2 flex flex-wrap gap-3.5">
            <Link href="/news" className="btn-fju group h-12 px-7 text-[17px]">
              查看最新公告
              <IconArrowRight className="size-4.5 transition-transform duration-300 group-hover:translate-x-1" aria-hidden />
            </Link>
            {/* 原型：登入後看歷屆專題一覽，訪客看優秀專題（註冊入口在頂列與登入頁）。 */}
            <Link href={member ? '/projects' : '/projects/featured'} className="btn-fju-ghost h-12 px-7 text-[17px]">
              {member ? '查看歷屆專題一覽' : '查看優秀專題'}
            </Link>
          </div>
        </div>
      </section>

      {member && home && work ? <WorkStrip home={home} work={work} /> : null}

      {/* 最新公告：灰藍標題板＋左兩張照片卡＋右側列表（系網招生訊息版型）。 */}
      <section className="mx-auto max-w-6xl px-5 pt-16 md:pt-20" aria-labelledby="home-news">
        <PanelTitle id="home-news" title="最新公告" action={{ href: '/news', label: '查看更多' }} />

        {latest.length === 0 ? (
          <ListEmpty className="mt-10" title="目前還沒有公告" hint="系辦發布公告後會出現在這裡。" />
        ) : (
          <div className="mt-10 grid gap-8 md:grid-cols-2 lg:grid-cols-[300px_300px_minmax(0,1fr)]">
            {cards.map((card, index) => (
              <NewsCard key={card.id} card={card} priority={index === 0} />
            ))}
            {rest.length > 0 ? (
              <ul className="flex flex-col gap-5 pt-1.5 md:col-span-2 lg:col-span-1">
                {rest.map((card) => (
                  <ListItem
                    key={card.id}
                    href={`/news/${card.id}`}
                    title={card.title}
                    meta={
                      <>
                        <time dateTime={card.publishedAt.toISOString()} className="text-[13px] font-semibold text-muted-foreground tabular-nums">
                          {publishedDate(card)}
                        </time>
                        {card.category ? <Tag>{card.category}</Tag> : null}
                        {card.audienceKind !== 'public' ? <Tag tone="ink">登入可見</Tag> : null}
                      </>
                    }
                  />
                ))}
              </ul>
            ) : null}
          </div>
        )}
      </section>

      {member ? (
        <section className="mt-24 bg-muted/50 py-20" aria-labelledby="home-archive">
          <div className="mx-auto flex max-w-6xl flex-col items-center gap-9 px-5">
            <div className="flex flex-col items-center gap-2 text-center">
              <SectionTitle id="home-archive">歷屆專題一覽</SectionTitle>
              <p className="text-[15px] text-muted-foreground">登入後的學習參考庫：三分鐘影片、摘要、海報與文件概述</p>
            </div>
            {archiveCards.length === 0 ? (
              <ListEmpty
                className="w-full bg-card"
                icon={<IconLayoutGrid className="size-9" aria-hidden />}
                title="歷屆專題還沒上架"
                hint="歷屆專題整理好之後會出現在這裡。"
              />
            ) : (
              <>
                <ul className="grid w-full gap-6 sm:grid-cols-2 lg:grid-cols-3" data-testid="home-archive-list">
                  {archiveCards.map((p) => (
                    <li key={p.id}>
                      <PhotoCard
                        href={`/projects/${encodeURIComponent(p.id)}`}
                        image={imageSrc(p.id, p.posterFileId)}
                        title={p.title}
                        tags={
                          <>
                            <Tag tone="ink">{p.cohortCode} 屆</Tag>
                            {p.groupCode ? <Tag>{p.groupCode}</Tag> : null}
                          </>
                        }
                      />
                    </li>
                  ))}
                </ul>
                <MoreButton href="/projects">進入歷屆專題一覽</MoreButton>
              </>
            )}
          </div>
        </section>
      ) : null}

      {/* 優秀專題（系網得獎焦點）。 */}
      <section className={cn('py-20', member ? '' : 'mt-24 bg-muted/50')} aria-labelledby="home-featured">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-9 px-5">
          <SectionTitle id="home-featured">優秀專題</SectionTitle>
          {featured.length === 0 ? (
            <ListEmpty
              className="w-full"
              icon={<IconTrophy className="size-9" aria-hidden />}
              title="優秀專題還沒公開"
              hint="系辦公開優秀專題之後會出現在這裡。"
            />
          ) : (
            <>
              <ul className="grid w-full gap-6 sm:grid-cols-2 lg:grid-cols-4" data-testid="home-featured-list">
                {featured.slice(0, 4).map((p) => (
                  <li key={p.id}>
                    <PhotoCard
                      href={`/projects/featured?item=${encodeURIComponent(p.id)}`}
                      image={imageSrc(p.id, p.posterFileId)}
                      badge={<AwardBadge award={p.award} label={p.awardLabel} className="absolute top-3 left-3 shadow-md" />}
                      title={p.title}
                      tags={
                        <>
                          <Tag tone="ink">{p.cohortCode} 屆</Tag>
                          {p.groupCode ? <Tag>{p.groupCode}</Tag> : null}
                        </>
                      }
                    />
                  </li>
                ))}
              </ul>
              <MoreButton href="/projects/featured" />
            </>
          )}
        </div>
      </section>

      {/* 榮譽與競賽：左大照片＋右標題板與列表（系網產業實習的鏡射）。 */}
      <section className="mt-4" aria-labelledby="home-honors">
        <div className="grid lg:grid-cols-[minmax(0,1fr)_760px]">
          <div className="relative min-h-[240px] sm:min-h-[320px] lg:min-h-[520px]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={honors[0] ? imageSrc(honors[0].id, honors[0].cover?.fileId) : '/placeholder/applause.jpg'}
              alt=""
              className="absolute inset-0 h-full w-full object-cover"
              loading="lazy"
            />
          </div>
          <div className="flex flex-col">
            <PanelTitle id="home-honors" title="榮譽與競賽" side="right" action={{ href: '/honors', label: '查看更多' }} />
            <div className="px-5 py-10 lg:pr-40 lg:pl-14">
              {honors.length === 0 ? (
                <ListEmpty
                  className="min-h-48"
                  icon={<IconTrophy className="size-9" aria-hidden />}
                  title="還沒有榮譽榜"
                  hint="系辦登錄得獎紀錄之後會出現在這裡。"
                />
              ) : (
                <ul className="flex flex-col gap-5" data-testid="home-honors-list">
                  {honors.map((h) => (
                    <ListItem
                      key={h.id}
                      href={`/honors?item=${encodeURIComponent(h.id)}`}
                      title={h.title}
                      meta={
                        <>
                          {/* 得獎日期（0011）；沒填退回發布日，跟 /honors 一樣。 */}
                          <span className="text-[13px] font-semibold text-muted-foreground tabular-nums">
                            {h.awardedOn ?? taipeiDateOf(h.publishedAt)}
                          </span>
                          <Tag>榮譽榜</Tag>
                          {h.category ? <Tag tone="ink">{h.category}</Tag> : null}
                        </>
                      }
                    />
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-5 pt-10">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-lg font-bold text-ink">進行中的競賽</h3>
            <Link href="/competitions" className="text-sm font-semibold text-primary hover:underline">
              全部競賽資訊 →
            </Link>
          </div>
          {competitionCards.length === 0 ? (
            <div className="flex min-h-24 items-center gap-3 rounded-[10px] border border-dashed border-border px-5 py-4 text-sm text-muted-foreground">
              <IconClock className="size-5 shrink-0" aria-hidden />
              目前沒有競賽資訊。系辦發布競賽資訊後會出現在這裡。
            </div>
          ) : (
            <ul className="grid gap-4 md:grid-cols-3" data-testid="home-competitions">
              {competitionCards.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/news/${c.id}`}
                    className="flex h-full flex-col gap-1.5 rounded-[10px] border border-border bg-card p-4.5 transition-colors hover:border-primary"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      {c.status ? <Tag tone={COMPETITION_STATUS[c.status].tone}>{COMPETITION_STATUS[c.status].label}</Tag> : <Tag>{COMPETITION_CATEGORY}</Tag>}
                      <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-muted-foreground tabular-nums">
                        <IconClock className="size-3.5" aria-hidden />
                        {competitionDate(c)}
                      </span>
                    </span>
                    <span className="text-[15px] leading-snug font-bold text-foreground">{c.title}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <QuickLinks home={home} member={member} />
    </SiteShell>
  )
}

/** 競賽狀態標籤（跟 /competitions 的 `STATUS` 同一套）：報名中橘、其他深藍。 */
const COMPETITION_STATUS = {
  open: { label: '報名中', tone: 'brand' },
  result: { label: '決賽／結果', tone: 'ink' },
  closed: { label: '已結束', tone: 'ink' },
} as const

/** 競賽卡上的日期（原型）：報名中看截止、有活動日看活動日；都沒有就是發布日。 */
function competitionDate(c: { status: string | null; registrationDeadline: string | null; eventDate: string | null; publishedAt: Date }): string {
  if (c.status === 'open' && c.registrationDeadline) return `截止 ${c.registrationDeadline.slice(5).replace('-', '/')}`
  if (c.eventDate) return `活動 ${c.eventDate.slice(5).replace('-', '/')}`
  if (c.registrationDeadline) return `截止 ${c.registrationDeadline.slice(5).replace('-', '/')}`
  return `發布 ${formatTaipeiDate(taipeiDateOf(c.publishedAt))}`
}

/** 暖白照片卡（原型 `PhotoCard`；首頁優秀專題）。 */
function PhotoCard({ href, image, title, tags, badge }: { href: string; image: string; title: string; tags: ReactNode; badge?: ReactNode }) {
  return (
    <Link
      href={href}
      className="group card-lift flex h-full flex-col overflow-hidden rounded-xl bg-secondary shadow-[0_2px_10px_rgba(0,51,102,0.08)]"
    >
      <div className="relative aspect-video overflow-hidden bg-muted">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={image} alt="" className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" loading="lazy" />
        {badge}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4.5">
        <span className="type-card-title text-foreground transition-colors group-hover:text-primary">{title}</span>
        <div className="mt-auto flex flex-wrap gap-1.5 pt-1">{tags}</div>
      </div>
    </Link>
  )
}

/** 置中的橘色外框寬按鈕（原型 `MoreButton`，系網「查看更多」）。 */
function MoreButton({ href, children = '查看更多' }: { href: string; children?: ReactNode }) {
  return (
    <Link href={href} className="btn-fju-outline press h-14 w-full max-w-[680px] text-xl">
      {children}
    </Link>
  )
}

/** 區塊大標：第一個字橘色（原型 `SectionTitle`）。 */
function SectionTitle({ id, children }: { id?: string; children: string }) {
  return (
    <h2 id={id} className="type-section text-center">
      <FirstCharAccent text={children} />
    </h2>
  )
}

/** 灰藍圓角標題板＋橘色按鈕（原型 `PanelTitle`；系網招生訊息／產業實習）。 */
function PanelTitle({
  id,
  title,
  action,
  side = 'left',
}: {
  id: string
  title: string
  action?: { href: string; label: string }
  side?: 'left' | 'right'
}) {
  return (
    <div
      className={cn(
        'fju-panel-title w-full max-w-[520px] px-6 py-5 md:px-10 md:py-6',
        side === 'left' ? 'rounded-tr-[40px] md:-ml-10' : 'self-end rounded-tl-[40px] lg:-mr-10',
      )}
    >
      <h2 id={id} className="type-section">
        <FirstCharAccent text={title} />
      </h2>
      {action ? (
        <Link href={action.href} className="btn-fju group h-10 px-5 text-[15px]">
          {action.label}
          <IconArrowRight className="size-4 transition-transform duration-300 group-hover:translate-x-1" aria-hidden />
        </Link>
      ) : null}
    </div>
  )
}

type MyWork = {
  /** 學生：還在開放、還沒正式送出的收件數（跟學生首頁「待繳交」同一份查詢、同一個函式）；不是學生是 null。 */
  readonly pending: number | null
  /** 還沒到的收件截止，近的在前（學生首頁行事曆同一份 `myDeadlines`；只查收件名單，老師、系辦的截止不在裡面）。 */
  readonly deadlines: readonly MyDeadline[]
}

/** 首頁「我的工作」要的資料：都是學生首頁已經在用的查詢，這裡只取前幾筆。 */
async function myWork(actor: Awaited<ReturnType<typeof currentActor>>): Promise<MyWork> {
  if (actor.kind !== 'authenticated') return { pending: null, deadlines: [] }
  const student = actorHasRole(actor, 'student')
  const [deadlines, items, now] = await Promise.all([
    getPublicItemQuery().myDeadlines(actor),
    student ? getSubmissionQuery().myItems(actor.userId) : Promise.resolve([]),
    getBusinessClock().now(),
  ])
  return {
    pending: student ? pendingCount(items, now) : null,
    deadlines: deadlines
      .filter((d) => d.dueAt.getTime() >= now.getTime())
      .sort((x, y) => x.dueAt.getTime() - y.dueAt.getTime())
      .slice(0, 3),
  }
}

/** 登入後的「我的工作」列＋近期截止（原型 `WorkStrip`）。 */
function WorkStrip({ home, work }: { home: string; work: MyWork }) {
  return (
    <section className="border-b border-border bg-muted/50" aria-label="我的工作">
      <div className="mx-auto grid max-w-6xl gap-8 px-5 py-10 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-bold text-foreground">我的工作</h2>
            <Link href={home} className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline">
              進入我的首頁 <IconArrowRight className="size-4" aria-hidden />
            </Link>
          </div>
          {work.pending !== null ? (
            <ul className="grid grid-cols-2 gap-3.5 sm:grid-cols-3">
              <li>
                <Link
                  href="/dashboard/student/affairs?tab=open"
                  className="card-lift flex h-full flex-col gap-2.5 rounded-[10px] border border-border bg-card p-5 hover:border-primary"
                >
                  <IconUpload className="size-5 text-primary" aria-hidden />
                  <span className="text-[17px] font-bold text-foreground" data-testid="home-work-pending">
                    待繳交 {work.pending} 件
                  </span>
                  <span className="text-[13px] text-muted-foreground">還在開放、還沒正式送出的收件</span>
                </Link>
              </li>
              <li>
                <Link
                  href={home}
                  className="card-lift flex h-full flex-col gap-2.5 rounded-[10px] border border-border bg-card p-5 hover:border-primary"
                >
                  <IconLayoutGrid className="size-5 text-primary" aria-hidden />
                  <span className="text-[17px] font-bold text-foreground">我的專題</span>
                  <span className="text-[13px] text-muted-foreground">組別、行事曆與階段</span>
                </Link>
              </li>
            </ul>
          ) : (
            <ListEmpty
              className="min-h-40 py-8"
              icon={<IconLayoutGrid className="size-8" aria-hidden />}
              title="待辦在後台"
              hint="要審的申請、要評的分數與要簽的名單，都在後台首頁。"
            />
          )}
        </div>
        <div className="flex flex-col gap-3.5 rounded-[10px] border border-border bg-card px-5.5 py-4.5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-bold text-foreground">近期截止</h2>
            {work.pending !== null ? (
              <Link href="/dashboard/student/affairs" className="text-[13px] font-semibold text-primary hover:underline">
                全部 →
              </Link>
            ) : null}
          </div>
          {work.deadlines.length > 0 ? (
            <ul className="flex flex-col gap-3.5" data-testid="home-deadlines">
              {work.deadlines.map((d) => (
                <li key={d.itemId} className="fju-list-item flex flex-col gap-1 py-1.5">
                  <Link href="/dashboard/student/affairs" className="flex items-center gap-3 hover:text-primary">
                    <span className="text-[22px] font-extrabold text-ink tabular-nums">
                      {formatTaipeiDate(taipeiDateOf(d.dueAt)).slice(5)}
                    </span>
                    <span className="min-w-0 text-base leading-snug font-bold break-words">{d.title}</span>
                  </Link>
                  <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-muted-foreground tabular-nums">
                    <IconClock className="size-3.5" aria-hidden />
                    截止 {formatTaipeiDate(taipeiDateOf(d.dueAt))}
                  </span>
                </li>
              ))}
            </ul>
          ) : work.pending === null ? (
            // 老師、系辦的截止（要審、要評、要簽）還沒有查詢撐著，不能說「沒有」，指回後台。
            <p className="flex flex-1 flex-wrap items-center gap-2 text-sm text-muted-foreground" data-testid="home-deadlines-elsewhere">
              <IconClock className="size-4 shrink-0" aria-hidden />
              要審、要評、要簽的截止事項在
              <Link href={home} className="font-semibold text-primary hover:underline">
                後台首頁
              </Link>
              。
            </p>
          ) : (
            // 只有學生（有 myDeadlines 這份真的查詢撐著）才說「沒有」。
            <p className="flex flex-1 items-center gap-2 text-sm text-muted-foreground">
              <IconClock className="size-4 shrink-0" aria-hidden />
              近期沒有要截止的項目。
            </p>
          )}
        </div>
      </div>
    </section>
  )
}

/** 頁尾前的三欄快速入口（原型 `home-blocks` 的 QuickLinks；只連已經有的頁）。 */
function QuickLinks({ home, member }: { home: string | null; member: boolean }) {
  const cols: { icon: ReactNode; title: string; links: { label: string; href: string }[] }[] = [
    {
      icon: <IconBook2 className="size-5.5" aria-hidden />,
      title: '專題規則',
      links: [
        { label: '修課限制、分組、課程要求與評分', href: '/rules' },
        { label: '最新公告', href: '/news' },
      ],
    },
    member && home
      ? {
          icon: <IconKey className="size-5.5" aria-hidden />,
          title: '我的入口',
          links: [
            { label: '我的首頁', href: home },
            { label: '檔案下載', href: '/files' },
            { label: '我的帳號', href: '/account' },
            { label: '產學合作', href: '/industry' },
          ],
        }
      : home
        ? {
            // 登入了但還不能用業務功能：待審核只給申請進度；臨時密碼還沒改的只給改密碼。
            icon: <IconKey className="size-5.5" aria-hidden />,
            title: '我的入口',
            links:
              home === '/register/pending'
                ? [{ label: '申請進度', href: home }]
                : [{ label: '更改密碼', href: '/account/change-password' }],
          }
        : {
            icon: <IconKey className="size-5.5" aria-hidden />,
            title: '使用平台',
            links: [
              { label: '登入', href: '/login' },
              { label: '註冊', href: '/register' },
            ],
          },
    {
      icon: <IconMail className="size-5.5" aria-hidden />,
      title: '系辦聯絡',
      links: [
        { label: '新莊區中正路 510 號 利瑪竇大樓', href: 'https://www.im.fju.edu.tw/' },
        { label: '電話 +886-2-2905-2696', href: 'tel:+886229052696' },
        { label: '系網 im.fju.edu.tw', href: 'https://www.im.fju.edu.tw/' },
      ],
    },
  ]
  return (
    <section className="relative mt-24 overflow-hidden bg-background" aria-label="快速入口">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/placeholder/building.jpg" alt="" className="absolute inset-0 h-full w-full object-cover opacity-10" loading="lazy" />
      <div className="absolute inset-0 bg-gradient-to-b from-background via-transparent to-background" aria-hidden />
      <div className="relative mx-auto grid max-w-6xl gap-10 px-5 py-18 md:grid-cols-3">
        {cols.map((c) => (
          <div key={c.title} className="flex flex-col gap-3.5">
            <div className="flex items-center gap-3 rounded-[10px] bg-card px-5 py-4 shadow-[0_2px_10px_rgba(0,51,102,0.08)]">
              <span className="text-primary">{c.icon}</span>
              <span className="text-xl font-bold">{c.title}</span>
            </div>
            <ul className="flex flex-col gap-2 px-2">
              {c.links.map((l) => (
                <li key={l.label}>
                  <Link href={l.href} className="group flex items-center gap-2 text-[15px] transition-colors hover:text-primary">
                    <span className="size-1.5 shrink-0 rounded-full bg-primary transition-transform duration-200 group-hover:scale-150" aria-hidden />
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  )
}
