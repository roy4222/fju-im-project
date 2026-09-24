import Link from 'next/link'
import type { ReactNode } from 'react'
import type { ItemFileSummary, PublicItemCard } from '@/application/items'
import { cn } from '@/shared/cn'
import { formatTaipeiDate, taipeiDateOf } from '@/shared/time'

/**
 * 前台內容頁共用的區塊（票 16；照原型 `/news`、`/news/[id]`、`/rules`、`/files` 的版型，收斂成系網橘單一主軸）。
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

/** 頁首：標題、一句說明、麵包屑。 */
export function PublicPageHead({ title, description, crumbs }: { title: string; description?: string; crumbs?: readonly { href?: string; label: string }[] }) {
  return (
    <header className="mb-6 border-b border-border pb-5">
      <nav aria-label="麵包屑" className="text-xs text-muted-foreground">
        <Link href="/" className="hover:text-ink">
          首頁
        </Link>
        {(crumbs ?? [{ label: title }]).map((c) => (
          <span key={c.label}>
            {' › '}
            {c.href ? (
              <Link href={c.href} className="hover:text-ink">
                {c.label}
              </Link>
            ) : (
              c.label
            )}
          </span>
        ))}
      </nav>
      <h1 className="mt-2 text-2xl font-semibold text-ink">{title}</h1>
      {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
    </header>
  )
}

export function Tag({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'brand' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold',
        tone === 'brand' ? 'bg-primary-subtle text-primary-on-subtle' : 'bg-muted text-muted-foreground',
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
      className="group flex h-full flex-col overflow-hidden rounded-card border border-border bg-background transition-colors hover:border-primary"
    >
      <div className="relative aspect-video bg-muted">
        {card.cover ? (
          // 封面走共用下載能力（每次重驗權限），不能用 next/image 的最佳化快取。
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/api/files/${card.cover.fileId}`} alt="" className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <div className="flex h-full items-center justify-center text-sm font-semibold text-muted-foreground">輔大資管專題</div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          {card.category ? <Tag>{card.category}</Tag> : null}
          {card.audienceKind !== 'public' ? <Tag tone="brand">登入可見</Tag> : null}
          <time dateTime={card.publishedAt.toISOString()} className="text-xs font-semibold text-muted-foreground tabular-nums">
            {publishedDate(card)}
          </time>
        </div>
        <h2 className="text-base font-semibold leading-snug text-ink group-hover:text-primary">{card.title}</h2>
        {card.summary ? <p className="line-clamp-2 text-sm text-muted-foreground">{card.summary}</p> : null}
      </div>
    </Link>
  )
}

/** 附件清單：每個檔案一顆下載（經 `/api/files/<id>`，每次重驗權限）。 */
export function AttachmentList({ files, label = '附件' }: { files: readonly ItemFileSummary[]; label?: string }) {
  if (files.length === 0) return null
  return (
    <section aria-label={label} className="rounded-card border border-border p-4">
      <p className="text-sm font-semibold text-ink">{label}</p>
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
      <p className="text-6xl font-bold text-ink tabular-nums">403</p>
      <h1 className="text-xl font-semibold text-ink">{what}需要登入</h1>
      <p className="text-sm text-muted-foreground">
        這裡的內容只提供本系學生與老師。登入後會回到你原本要看的頁面。
      </p>
      <div className="mt-2 flex gap-2">
        <Link href={`/login?next=${encodeURIComponent(next)}`} className="rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
          登入
        </Link>
        <Link href="/" className="rounded-md border border-border px-5 py-2 text-sm font-medium text-ink hover:bg-muted">
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
    <div className="mx-auto max-w-xl rounded-card border border-border bg-surface px-6 py-10 text-center" data-testid="gone-notice">
      <h1 className="text-xl font-semibold text-ink">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{detail}</p>
      <p className="mt-1 text-sm text-muted-foreground">有問題請聯絡系辦。</p>
      <div className="mt-5 flex justify-center gap-2">
        <Link href={back.href} className="rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
          {back.label}
        </Link>
        <Link href="/" className="rounded-md border border-border px-5 py-2 text-sm font-medium text-ink hover:bg-muted">
          回首頁
        </Link>
      </div>
    </div>
  )
}

/** 列表沒有結果時：說明現在的條件、給一個清除條件的連結。 */
export function ListEmpty({ title, hint, clearHref }: { title: string; hint: string; clearHref?: string }) {
  return (
    <div className="rounded-card border border-dashed border-border bg-surface px-6 py-10 text-center">
      <p className="text-base font-medium text-ink">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{hint}</p>
      {clearHref ? (
        <Link href={clearHref} className="mt-3 inline-block text-sm font-semibold text-primary hover:underline">
          清除條件
        </Link>
      ) : null}
    </div>
  )
}
