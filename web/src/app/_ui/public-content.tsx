import Link from 'next/link'
import type { ReactNode } from 'react'
import type { ItemFileSummary, PublicItemCard } from '@/application/items'
import { cn } from '@/shared/cn'
import { formatTaipeiDate, taipeiDateOf } from '@/shared/time'

/**
 * 前台內容頁共用的區塊（票 16；照原型 `/news`、`/news/[id]`、`/rules`、`/files` 的版型，收斂成系網橘單一主軸）。
 * 外觀照原型 `components/public/blocks.tsx`（2026-09-25 對齊）：首字橘色大標、暖白照片卡、細框標籤。
 *
 * 都是 server component。正文只接受**已經過 `renderBodyHtml` 清理**的字串（`PublicItemPage.item.bodyHtml`）。
 */

export function publishedDate(card: Pick<PublicItemCard, 'publishedAt'>): string {
  return formatTaipeiDate(taipeiDateOf(card.publishedAt))
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/** 首字橘色（系網的大標做法）。 */
export function FirstCharAccent({ text }: { text: string }) {
  const [first, ...rest] = Array.from(text)
  return (
    <>
      <span className="text-primary">{first}</span>
      {rest.join('')}
    </>
  )
}

/** 頁首：麵包屑、首字橘色的大標、一句說明（原型 `PageHead`）。 */
export function PublicPageHead({ title, description, crumbs }: { title: string; description?: string; crumbs?: readonly { href?: string; label: string }[] }) {
  return (
    <header className="mb-8 border-b border-border pb-7">
      <nav aria-label="麵包屑" className="text-[13px] text-muted-foreground">
        <Link href="/" className="hover:text-foreground">
          首頁
        </Link>
        {(crumbs ?? [{ label: title }]).map((c) => (
          <span key={c.label}>
            {' › '}
            {c.href ? (
              <Link href={c.href} className="hover:text-foreground">
                {c.label}
              </Link>
            ) : (
              c.label
            )}
          </span>
        ))}
      </nav>
      <h1 className="mt-2.5 text-[28px] leading-tight font-extrabold text-foreground sm:text-[34px]">
        <FirstCharAccent text={title} />
      </h1>
      {description ? <p className="mt-2.5 max-w-3xl text-[15px] text-muted-foreground">{description}</p> : null}
    </header>
  )
}

export function Tag({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'brand' }) {
  return (
    // 原型 Tag：4px 圓角細框；橘＝要注意的，深藍＝一般分類。
    <span
      className={cn(
        'inline-flex h-6 items-center rounded-[4px] border bg-background px-2 text-xs font-semibold',
        tone === 'brand' ? 'border-primary text-primary' : 'border-ink/60 text-ink',
      )}
    >
      {children}
    </span>
  )
}

/** 公告卡：封面（16:9，沒有封面就留色塊）、分類、日期、標題、摘要。非公開的標「登入可見」。 */
export function NewsCard({ card }: { card: PublicItemCard }) {
  return (
    <Link
      href={`/news/${card.id}`}
      data-testid="news-card"
      className="group card-lift flex h-full flex-col overflow-hidden rounded-xl bg-secondary shadow-[0_2px_10px_rgba(0,51,102,0.08)]"
    >
      <div className="relative aspect-video overflow-hidden bg-muted">
        {card.cover ? (
          // 封面走共用下載能力（每次重驗權限），不能用 next/image 的最佳化快取。
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/api/files/${card.cover.fileId}`} alt="" className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" loading="lazy" />
        ) : (
          <div className="flex h-full items-center justify-center bg-ink text-sm font-bold tracking-widest text-ink-foreground/80">輔大資管專題</div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4.5">
        <div className="flex flex-wrap items-center gap-2">
          {card.category ? <Tag>{card.category}</Tag> : null}
          {card.audienceKind !== 'public' ? <Tag tone="brand">登入可見</Tag> : null}
          <time dateTime={card.publishedAt.toISOString()} className="text-[13px] font-semibold text-muted-foreground tabular-nums">
            {publishedDate(card)}
          </time>
        </div>
        <h2 className="type-card-title text-foreground group-hover:text-primary">{card.title}</h2>
        {card.summary ? <p className="line-clamp-2 text-sm text-muted-foreground">{card.summary}</p> : null}
      </div>
    </Link>
  )
}

/** 附件清單：每個檔案一顆下載（經 `/api/files/<id>`，每次重驗權限）。 */
export function AttachmentList({ files, label = '附件' }: { files: readonly ItemFileSummary[]; label?: string }) {
  if (files.length === 0) return null
  return (
    <section aria-label={label} className="rounded-xl border border-border bg-card p-5">
      <p className="text-sm font-bold text-foreground">{label}</p>
      <ul className="mt-2 space-y-1.5">
        {files.map((f) => (
          <li key={f.fileId} className="flex flex-wrap items-center justify-between gap-2">
            <a href={`/api/files/${f.fileId}`} className="text-sm font-medium text-primary-on-subtle underline-offset-2 hover:underline">
              {f.name}
            </a>
            <span className="text-xs text-muted-foreground tabular-nums">{formatSize(f.sizeBytes)}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** 正文：只接受伺服器端清理過的 HTML（`renderBodyHtml` 的輸出）。 */
export function CleanBody({ html }: { html: string }) {
  if (html.trim() === '') return null
  return <div className="prose-item space-y-3 text-base leading-loose text-ink" dangerouslySetInnerHTML={{ __html: html }} />
}

/**
 * 需要登入（照原型的 403 版型）：說清楚為什麼、登入後回到原頁。
 * 不透露這一頁是什麼內容。
 */
export function NeedLogin({ next, what }: { next: string; what: string }) {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-3 py-12 text-center" data-testid="need-login">
      <p className="text-7xl font-extrabold text-ink tabular-nums">403</p>
      <h1 className="text-[22px] font-extrabold text-foreground">{what}需要登入</h1>
      <p className="text-sm text-muted-foreground">
        這裡的內容只提供本系學生與老師。登入後會回到你原本要看的頁面。
      </p>
      <div className="mt-2 flex gap-2">
        <Link href={`/login?next=${encodeURIComponent(next)}`} className="btn-fju h-11 px-6 text-[15px]">
          登入
        </Link>
        <Link href="/" className="btn-fju-outline h-11 px-6 text-[15px]">
          回首頁
        </Link>
      </div>
    </div>
  )
}

/**
 * 已下架／已撤回（產品 04 §4.5、09 SHW-06、08「來源已撤回」）：不是 404，告訴他發生什麼事、接下來可以去哪裡。
 * 不帶原本的標題與內容。
 */
export function GoneNotice({
  kind,
  what,
  back,
}: {
  kind: 'archived' | 'withdrawn'
  what: string
  back: { href: string; label: string }
}) {
  const title = kind === 'archived' ? `這則${what}已下架` : `這則${what}已撤回`
  const detail =
    kind === 'archived'
      ? '系辦已經把它下架，內容不再公開。可能已經過期，或被新的公告取代。'
      : '系辦暫時把它收回修改，改好後會在原本的網址重新發布。'
  return (
    <div className="mx-auto max-w-xl rounded-xl border border-border bg-card px-6 py-12 text-center" data-testid="gone-notice">
      <h1 className="text-[22px] font-extrabold text-foreground">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{detail}</p>
      <p className="mt-1 text-sm text-muted-foreground">有問題請聯絡系辦。</p>
      <div className="mt-5 flex justify-center gap-2">
        <Link href={back.href} className="btn-fju h-11 px-6 text-[15px]">
          {back.label}
        </Link>
        <Link href="/" className="btn-fju-outline h-11 px-6 text-[15px]">
          回首頁
        </Link>
      </div>
    </div>
  )
}

/** 列表沒有結果時：說明現在的條件、給一個清除條件的連結。 */
export function ListEmpty({ title, hint, clearHref }: { title: string; hint: string; clearHref?: string }) {
  return (
    // 原型 ListState：白卡置中、一句粗體、一行灰字。
    <div className="flex min-h-64 flex-col items-center justify-center gap-2.5 rounded-xl border border-border bg-card px-6 py-12 text-center">
      <p className="text-base font-bold text-foreground">{title}</p>
      <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">{hint}</p>
      {clearHref ? (
        <Link href={clearHref} className="mt-2 inline-block text-sm font-bold text-primary hover:underline">
          清除條件
        </Link>
      ) : null}
    </div>
  )
}
