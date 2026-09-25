import Link from 'next/link'
import type { ReactNode } from 'react'
import { IconCrown, IconFileText, IconLock, IconSearch, IconSearchOff, IconTrophy } from '@tabler/icons-react'
import type { ItemFileSummary, PublicItemCard } from '@/application/items'
import type { ShowcaseAward } from '@/application/showcase'
import { cn } from '@/shared/cn'
import { formatTaipeiDate, taipeiDateOf } from '@/shared/time'

/**
 * 前台內容頁共用的區塊（票 16；照原型 `/news`、`/news/[id]`、`/rules`、`/files` 的版型，收斂成系網橘單一主軸）。
 * 外觀照原型 `components/public/blocks.tsx`（2026-09-25 對齊）：灰底頁首帶、首字橘色大標、暖白照片卡、細框標籤。
 *
 * 色名對照（見 globals.css 檔頭）：原型的 `primary`（深藍）＝這裡的 `ink`，原型的 `brand`（橘）＝這裡的 `primary`。
 *
 * 都是 server component。正文只接受**已經過 `renderBodyHtml` 清理**的字串（`PublicItemPage.item.bodyHtml`）。
 */

export function publishedDate(card: Pick<PublicItemCard, 'publishedAt'>): string {
  return formatTaipeiDate(taipeiDateOf(card.publishedAt))
}

export function formatSize(bytes: number): string {
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

type Crumb = { href?: string; label: string }

/** 麵包屑：首頁 › … 。 */
export function Crumbs({ items }: { items: readonly Crumb[] }) {
  return (
    <nav aria-label="麵包屑" className="text-[13px] text-muted-foreground">
      <ol className="flex flex-wrap items-center gap-1.5">
        <li>
          <Link href="/" className="hover:text-foreground">
            首頁
          </Link>
        </li>
        {items.map((c) => (
          <li key={c.label} className="flex min-w-0 items-center gap-1.5">
            <span aria-hidden>›</span>
            {c.href ? (
              <Link href={c.href} className="hover:text-foreground">
                {c.label}
              </Link>
            ) : (
              <span className="min-w-0 break-all">{c.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}

/** 內頁頁首帶（原型 `PageHead`）：滿版灰底、麵包屑、首字橘色大標、一句說明。放在 `SiteShell bare` 裡。 */
export function PublicPageHead({ title, description, crumbs }: { title: string; description?: string; crumbs?: readonly Crumb[] }) {
  return (
    <div className="border-b border-border bg-muted/50">
      <div className="mx-auto max-w-6xl px-5 py-9">
        <Crumbs items={crumbs ?? [{ label: title }]} />
        <h1 className="mt-2.5 text-[30px] leading-tight font-extrabold text-foreground sm:text-[34px]">
          <FirstCharAccent text={title} />
        </h1>
        {description ? <p className="mt-2.5 max-w-3xl text-[15px] text-muted-foreground">{description}</p> : null}
      </div>
    </div>
  )
}

/** 有頁首帶的內頁：頁首帶＋置中內容欄（原型列表頁的版型）。 */
export function PublicPage({
  title,
  description,
  crumbs,
  children,
  className,
}: {
  title: string
  description?: string
  crumbs?: readonly Crumb[]
  children: ReactNode
  className?: string
}) {
  return (
    <>
      <PublicPageHead title={title} description={description} crumbs={crumbs} />
      <div className={cn('mx-auto w-full max-w-6xl px-5 py-10', className)}>{children}</div>
    </>
  )
}

/** 原型 Tag：4px 圓角細框；橘＝分類，深藍＝狀態（登入可見、已有組別）。 */
export function Tag({ children, tone = 'brand', className }: { children: ReactNode; tone?: 'brand' | 'ink'; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-6 shrink-0 items-center rounded-[4px] border bg-background px-2 text-xs font-semibold whitespace-nowrap',
        tone === 'brand' ? 'border-primary text-primary' : 'border-ink text-ink',
        className,
      )}
    >
      {children}
    </span>
  )
}

/**
 * 獎項徽章（原型 `AwardBadge`）：優秀專題＝橘底王冠、佳作＝深藍底獎盃；沒有等級不畫。
 * `label` 是獎項全名，放在 title 讓滑過看得到。
 */
export function AwardBadge({ award, label, className }: { award: ShowcaseAward | null | undefined; label?: string | null; className?: string }) {
  if (!award) return null
  const excellent = award === 'excellent'
  return (
    <span
      className={cn(
        'inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-bold',
        excellent ? 'bg-primary text-primary-foreground' : 'bg-ink text-ink-foreground',
        className,
      )}
      title={label ?? undefined}
      data-testid="award-badge"
    >
      {excellent ? <IconCrown className="size-3.5" aria-hidden /> : <IconTrophy className="size-3.5" aria-hidden />}
      {excellent ? '優秀專題' : '佳作'}
    </span>
  )
}

/** 篩選 pill（原型 `PillLink`）：連結版，狀態在網址上。橘＝公告分類，深藍＝一般篩選。 */
export function PillLink({
  href,
  active,
  tone = 'ink',
  children,
}: {
  href: string
  active: boolean
  tone?: 'brand' | 'ink'
  children: ReactNode
}) {
  const on = tone === 'brand' ? 'border-primary bg-primary text-primary-foreground' : 'border-ink bg-ink text-ink-foreground'
  const off = tone === 'brand' ? 'border-primary text-primary hover:bg-primary-subtle' : 'border-border text-foreground hover:border-ink/40 hover:bg-accent'
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'press inline-flex h-9 items-center rounded-full border px-4 text-sm font-semibold transition-[background-color,border-color,color] duration-200',
        active ? `${on} shadow-[0_2px_8px_rgba(0,51,102,0.18)]` : off,
      )}
    >
      {children}
    </Link>
  )
}

/**
 * 搜尋框（原型列表頁）：放大鏡在框內、按 Enter 送出（GET，條件在網址上）。
 * 其他要一起帶上的條件用 `keep` 傳進來（hidden input）。
 */
export function SearchField({
  action,
  id,
  label,
  placeholder,
  defaultValue,
  keep = {},
  className,
  inputClassName,
  children,
}: {
  action: string
  id: string
  label: string
  placeholder: string
  defaultValue: string
  keep?: Record<string, string>
  className?: string
  /** 搜尋框的寬度（預設手機滿版、桌機 288px）。 */
  inputClassName?: string
  /** 同一個表單裡的其他控制項（例如排序）。 */
  children?: ReactNode
}) {
  return (
    <form action={action} role="search" className={cn('flex flex-wrap items-center gap-2.5', className)}>
      {Object.entries(keep).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <div className={cn('relative w-full sm:w-72', inputClassName)}>
        <IconSearch className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <input
          id={id}
          name="q"
          type="search"
          defaultValue={defaultValue}
          placeholder={placeholder}
          className="h-10 w-full rounded-md border border-input bg-background pr-3 pl-9 text-sm outline-none transition-[border-color,box-shadow] hover:border-ink/30 focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/20"
        />
      </div>
      {children}
    </form>
  )
}

/** 公告卡（原型 `PhotoCard`）：16:9 封面（沒有封面就用示意照片）、日期、標題、標籤。 */
export function NewsCard({ card, priority = false }: { card: PublicItemCard; priority?: boolean }) {
  return (
    <Link
      href={`/news/${card.id}`}
      data-testid="news-card"
      className="group card-lift flex h-full flex-col overflow-hidden rounded-xl bg-secondary shadow-[0_2px_10px_rgba(0,51,102,0.08)]"
    >
      <div className="relative aspect-video overflow-hidden bg-muted">
        {/* 不用 next/image：上傳的封面每次重驗權限不能進最佳化快取，而且 next/image 會輸出被 CSP 擋的 style 屬性。 */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={coverSrc(card)}
          alt=""
          className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
          loading={priority ? 'eager' : 'lazy'}
        />
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4.5">
        <time dateTime={card.publishedAt.toISOString()} className="text-[13px] font-semibold text-muted-foreground tabular-nums">
          {publishedDate(card)}
        </time>
        <h2 className="type-card-title text-foreground transition-colors group-hover:text-primary">{card.title}</h2>
        {card.category || card.audienceKind !== 'public' ? (
          <div className="mt-auto flex flex-wrap gap-1.5 pt-1">
            {card.category ? <Tag>{card.category}</Tag> : null}
            {card.audienceKind !== 'public' ? (
              <Tag tone="ink">
                <IconLock className="mr-1 size-3" aria-hidden />
                登入可見
              </Tag>
            ) : null}
          </div>
        ) : null}
      </div>
    </Link>
  )
}

/**
 * 還沒有封面的公告，先放原型的示意照片（`public/placeholder/`，Roy 2026-09-25：前台外觀先照原型）。
 * 依 id 穩定地挑一張，同一則公告在列表與內容頁看到的是同一張。
 * 只挑純照片：hackathon、showcase 是印著活動名稱的海報，放在別則公告上會讓人誤會。
 */
const PLACEHOLDER_PHOTOS = ['students', 'lounge', 'atrium', 'study', 'present', 'applause', 'phone'] as const

export function placeholderPhoto(id: string): string {
  let hash = 0
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return `/placeholder/${PLACEHOLDER_PHOTOS[hash % PLACEHOLDER_PHOTOS.length]}.jpg`
}

/** 圖片網址：有檔案就走共用下載能力（每次重驗權限），沒有就用依 id 挑的示意照片（精選海報、榮譽封面共用）。 */
export function imageSrc(id: string, fileId: string | null | undefined): string {
  return fileId ? `/api/files/${fileId}` : placeholderPhoto(id)
}

/** 公告的封面網址：有上傳封面就走共用下載能力（每次重驗權限），沒有就用示意照片。 */
export function coverSrc(card: Pick<PublicItemCard, 'id' | 'cover'>): string {
  return imageSrc(card.id, card.cover?.fileId)
}

/** 深藍左線列表項（原型 `ListItem`；首頁右欄、內容頁側欄）。 */
export function ListItem({ href, title, meta }: { href: string; title: string; meta: ReactNode }) {
  return (
    <li className="fju-list-item flex flex-col gap-1.5 py-1.5">
      <Link href={href} className="link-ink text-[17px] leading-snug font-bold">
        {title}
      </Link>
      <div className="flex flex-wrap items-center gap-2.5">{meta}</div>
    </li>
  )
}

/** 前台的白卡區塊（原型 `/account` 的表單卡）：細框、12px 圓角、標題 18px 粗體。 */
export function PublicCard({
  title,
  description,
  children,
  className,
  ...rest
}: {
  title?: string
  description?: string
  children?: ReactNode
  className?: string
} & Omit<React.HTMLAttributes<HTMLElement>, 'title'>) {
  return (
    <section className={cn('flex flex-col gap-4.5 rounded-xl border border-border bg-card p-5 sm:p-7', className)} {...rest}>
      {title || description ? (
        <div className="flex flex-col gap-1">
          {title ? <h2 className="text-lg font-bold text-foreground">{title}</h2> : null}
          {description ? <p className="text-[13px] leading-relaxed text-muted-foreground">{description}</p> : null}
        </div>
      ) : null}
      {children}
    </section>
  )
}

/** 附件清單（原型公告內容頁的附件框）：每個檔案一列，經 `/api/files/<id>` 下載（每次重驗權限）。 */
export function AttachmentList({ files, label = '附件' }: { files: readonly ItemFileSummary[]; label?: string }) {
  if (files.length === 0) return null
  return (
    <section aria-label={label} className="flex flex-col gap-2.5 rounded-[10px] border border-border p-5">
      <p className="font-bold text-foreground">附件</p>
      <ul className="flex flex-col gap-2">
        {files.map((f) => (
          <li key={f.fileId}>
            <a href={`/api/files/${f.fileId}`} className="group inline-flex max-w-full items-center gap-2.5 text-ink hover:text-primary">
              <IconFileText className="size-5 shrink-0" aria-hidden />
              <span className="min-w-0 font-semibold break-all">{f.name}</span>
              <span className="shrink-0 text-[13px] text-muted-foreground tabular-nums">{formatSize(f.sizeBytes)}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** 正文：只接受伺服器端清理過的 HTML（`renderBodyHtml` 的輸出）。 */
export function CleanBody({ html, className }: { html: string; className?: string }) {
  if (html.trim() === '') return null
  return (
    <div
      className={cn('prose-item space-y-3 text-base leading-loose break-words text-foreground', className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

/**
 * 大數字的說明頁（原型的 403 版型）：數字、圖示、一句標題、一段說明、兩顆按鈕。
 * 需要登入、沒有權限都用這個樣子。
 */
export function CodeNotice({
  code,
  icon,
  title,
  children,
  actions,
  ...rest
}: {
  code: string
  icon: ReactNode
  title: string
  children: ReactNode
  actions: ReactNode
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className="mx-auto flex min-h-[480px] max-w-xl flex-col items-center justify-center gap-4 px-5 py-16 text-center sm:min-h-[560px]" {...rest}>
      <span className="text-[72px] leading-none font-extrabold text-ink tabular-nums sm:text-[88px]">{code}</span>
      <span className="text-muted-foreground">{icon}</span>
      <h1 className="text-[24px] font-extrabold text-foreground sm:text-[28px]">{title}</h1>
      <div className="text-base leading-relaxed text-muted-foreground">{children}</div>
      <div className="mt-2 flex flex-wrap justify-center gap-3">{actions}</div>
    </div>
  )
}

/**
 * 需要登入（照原型的 403 版型）：說清楚為什麼、登入後回到原頁。
 * 不透露這一頁是什麼內容。
 */
export function NeedLogin({ next, what }: { next: string; what: string }) {
  return (
    <CodeNotice
      code="403"
      icon={<IconLock className="size-7" aria-hidden />}
      title={`${what}需要登入`}
      data-testid="need-login"
      actions={
        <>
          <Link href={`/login?next=${encodeURIComponent(next)}`} className="btn-fju h-11.5 px-7 text-[15px]">
            登入
          </Link>
          <Link href="/" className="btn-fju-outline h-11.5 px-7 text-[15px]">
            回首頁
          </Link>
        </>
      }
    >
      這裡的內容只提供本系學生與老師。登入後會回到你原本要看的頁面。
    </CodeNotice>
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
    <div className="mx-auto flex min-h-[420px] max-w-xl flex-col items-center justify-center gap-3 px-5 py-16 text-center" data-testid="gone-notice">
      <IconSearchOff className="size-9 text-muted-foreground/60" aria-hidden />
      <h1 className="text-[24px] font-extrabold text-foreground sm:text-[28px]">{title}</h1>
      <p className="text-base leading-relaxed text-muted-foreground">
        {detail}
        <br />
        有問題請聯絡系辦。
      </p>
      <div className="mt-2 flex flex-wrap justify-center gap-3">
        <Link href={back.href} className="btn-fju h-11.5 px-7 text-[15px]">
          {back.label}
        </Link>
        <Link href="/" className="btn-fju-outline h-11.5 px-7 text-[15px]">
          回首頁
        </Link>
      </div>
    </div>
  )
}

/** 列表沒有結果時（原型 `ListState`）：圖示、一句粗體、一行灰字、清除條件。 */
export function ListEmpty({
  title,
  hint,
  clearHref,
  icon,
  className,
}: {
  title: string
  hint: string
  clearHref?: string
  icon?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex min-h-64 flex-col items-center justify-center gap-2.5 rounded-xl border border-border bg-card px-6 py-12 text-center', className)}>
      <span className="text-muted-foreground/60">{icon ?? <IconSearchOff className="size-9" aria-hidden />}</span>
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
