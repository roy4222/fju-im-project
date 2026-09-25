import Link from 'next/link'
import type { ReactNode } from 'react'
import { IconArrowRight, IconBook2, IconKey, IconMail } from '@tabler/icons-react'
import { currentActor, homeFor } from '@/app/_ui/guard'
import { FirstCharAccent, ListEmpty, NewsCard, Tag, publishedDate } from '@/app/_ui/public-content'
import { SiteShell } from '@/app/_ui/site-shell'
import { getPublicItemQuery } from '@/composition/items'

/**
 * 公開首頁（票 16 先做「最新公告」一區；產品模組 09 §9.2：重要消息優先、每區幾筆再進完整列表）。
 *
 * 版型照原型首頁（2026-09-25 對齊）：深藍 hero → 最新公告（兩張照片卡＋右側列表）→ 快速入口。
 * 原型的優秀專題、榮譽與競賽、登入後的「我的工作」要等那些資料做出來（開發計畫第 6 節）才放，
 * 不拿假資料撐版面。
 */
export default async function HomePage() {
  const actor = await currentActor()
  const signedIn = actor.kind === 'authenticated'
  const latest = await getPublicItemQuery().list(actor, 'news', { limit: 6 })
  const [cards, rest] = [latest.slice(0, 2), latest.slice(2)]

  return (
    <SiteShell bare>
      {/* Hero：系網深藍（原型用校園照片疊深藍漸層；正式站先不放照片）。 */}
      <section className="relative overflow-hidden bg-ink text-ink-foreground" aria-label="專題管理平台">
        <div aria-hidden className="absolute -top-40 -right-24 size-[520px] rounded-full bg-[oklch(0.45_0.12_250)] opacity-60" />
        <div aria-hidden className="absolute right-64 -bottom-56 size-[380px] rounded-full bg-[oklch(0.4_0.11_250)] opacity-60" />
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
            {signedIn ? (
              <Link href={homeFor(actor)} className="btn-fju-ghost h-12 px-7 text-[17px]">
                回到我的首頁
              </Link>
            ) : (
              <Link href="/register" className="btn-fju-ghost h-12 px-7 text-[17px]">
                我要註冊
              </Link>
            )}
          </div>
        </div>
      </section>

      {/* 最新公告：灰藍標題板＋左兩張照片卡＋右側列表（系網招生訊息版型）。 */}
      <section className="mx-auto max-w-6xl px-5 pt-16 md:pt-20" aria-labelledby="home-news">
        <div className="fju-panel-title w-full max-w-[520px] rounded-tr-[40px] px-6 py-5 md:-ml-10 md:px-10 md:py-6">
          <h2 id="home-news" className="type-section">
            <FirstCharAccent text="最新公告" />
          </h2>
          <Link href="/news" className="btn-fju group h-10 px-5 text-[15px]">
            查看更多
            <IconArrowRight className="size-4 transition-transform duration-300 group-hover:translate-x-1" aria-hidden />
          </Link>
        </div>

        {latest.length === 0 ? (
          <div className="mt-10">
            <ListEmpty title="目前還沒有公告" hint="系辦發布公告後會出現在這裡。" />
          </div>
        ) : (
          <div className="mt-10 grid gap-8 lg:grid-cols-[300px_300px_minmax(0,1fr)]">
            {cards.map((card) => (
              <NewsCard key={card.id} card={card} />
            ))}
            {rest.length > 0 ? (
              <ul className="flex flex-col gap-5 pt-1.5">
                {rest.map((card) => (
                  <li key={card.id} className="fju-list-item flex flex-col gap-1.5 py-1.5">
                    <Link href={`/news/${card.id}`} className="link-ink text-[17px] leading-snug font-bold">
                      {card.title}
                    </Link>
                    <div className="flex flex-wrap items-center gap-2.5">
                      <time dateTime={card.publishedAt.toISOString()} className="text-[13px] font-semibold text-muted-foreground tabular-nums">
                        {publishedDate(card)}
                      </time>
                      {card.category ? <Tag>{card.category}</Tag> : null}
                      {card.audienceKind !== 'public' ? <Tag tone="brand">登入可見</Tag> : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
      </section>

      <QuickLinks signedIn={signedIn} home={signedIn ? homeFor(actor) : null} />
    </SiteShell>
  )
}

/** 頁尾前的三欄快速入口（原型 `home-blocks` 的 QuickLinks；只連已經有的頁）。 */
function QuickLinks({ signedIn, home }: { signedIn: boolean; home: string | null }) {
  const cols: { icon: ReactNode; title: string; links: { label: string; href: string }[] }[] = [
    {
      icon: <IconBook2 className="size-5.5" aria-hidden />,
      title: '專題規則',
      links: [
        { label: '修課限制、分組、課程要求與評分', href: '/rules' },
        { label: '最新公告', href: '/news' },
      ],
    },
    signedIn && home
      ? {
          icon: <IconKey className="size-5.5" aria-hidden />,
          title: '我的入口',
          links: [
            { label: '我的首頁', href: home },
            { label: '檔案下載', href: '/files' },
            { label: '產學合作', href: '/industry' },
            { label: '我的帳號', href: '/account' },
          ],
        }
      : {
          icon: <IconKey className="size-5.5" aria-hidden />,
          title: '使用平台',
          links: [
            { label: '登入', href: '/login' },
            { label: '學生註冊', href: '/register' },
            { label: '檔案下載（登入後）', href: '/files' },
          ],
        },
    {
      icon: <IconMail className="size-5.5" aria-hidden />,
      title: '系辦聯絡',
      links: [
        { label: '電話 +886-2-2905-2696', href: 'tel:+886229052696' },
        { label: '系網 im.fju.edu.tw', href: 'https://www.im.fju.edu.tw/' },
      ],
    },
  ]
  return (
    <section className="mt-20 bg-muted/50" aria-label="快速入口">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-16 md:grid-cols-3">
        {cols.map((c) => (
          <div key={c.title} className="flex flex-col gap-3.5">
            <div className="flex items-center gap-3 rounded-[10px] bg-card px-5 py-4 shadow-[0_2px_10px_rgba(0,51,102,0.08)]">
              <span className="text-primary">{c.icon}</span>
              <span className="text-xl font-bold">{c.title}</span>
            </div>
            <ul className="flex flex-col gap-2 px-2">
              {c.links.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="group flex items-center gap-2 text-[15px] transition-colors hover:text-primary">
                    <span className="size-1.5 rounded-full bg-primary transition-transform duration-200 group-hover:scale-150" aria-hidden />
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
