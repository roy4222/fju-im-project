import Link from 'next/link'
import type { ReactNode } from 'react'
import { cn } from '@/shared/cn'

/**
 * 前台列表頁共用的區塊（照原型 `components/public/blocks.tsx` 的 `PageHead`、`Tag`、`ListState`）。
 *
 * 原型的 `primary` 是深藍、`brand` 是橘；web 的 `primary` 是橘（`brand` 是它的別名）、深藍叫 `ink`。
 * 所以原型寫 `primary` 的地方這裡一律寫 `ink`。
 */

/** 內頁頁首帶：滿版灰底、麵包屑、首字橘色大標、一句說明（外殼要用 `SiteShell bare`）。 */
export function PageBand({
  title,
  description,
  crumbs,
}: {
  title: string
  description?: string
  crumbs: readonly { href?: string; label: string }[]
}) {
  const [first, ...rest] = Array.from(title)
  return (
    <div className="border-b border-border bg-muted/50">
      <div className="mx-auto max-w-6xl px-5 py-9">
        <nav aria-label="麵包屑" className="text-[13px] text-muted-foreground">
          <ol className="flex flex-wrap items-center gap-1.5">
            <li>
              <Link href="/" className="hover:text-foreground">
                首頁
              </Link>
            </li>
            {crumbs.map((c) => (
              <li key={c.label} className="flex items-center gap-1.5">
                <span aria-hidden>›</span>
                {c.href ? (
                  <Link href={c.href} className="hover:text-foreground">
                    {c.label}
                  </Link>
                ) : (
                  <span>{c.label}</span>
                )}
              </li>
            ))}
          </ol>
        </nav>
        <h1 className="mt-2.5 text-[28px] leading-tight font-extrabold text-foreground sm:text-[34px]">
          <span className="text-primary">{first}</span>
          {rest.join('')}
        </h1>
        {description ? <p className="mt-2.5 max-w-3xl text-[15px] text-muted-foreground">{description}</p> : null}
      </div>
    </div>
  )
}

export type TagTone = 'brand' | 'navy'

/** 細框標籤：橘＝要注意的／類別，深藍＝屆別、組別這類一般資訊。 */
export function ToneTag({ children, tone = 'brand', className }: { children: ReactNode; tone?: TagTone; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center rounded-[4px] border bg-background px-2 text-xs font-semibold',
        tone === 'brand' ? 'border-primary text-primary' : 'border-ink text-ink',
        className,
      )}
    >
      {children}
    </span>
  )
}

/** 列表狀態：空白／沒有搜尋結果（白卡置中、圖示、一句粗體、一行灰字、可選的下一步）。 */
export function ListState({ icon, title, hint, action }: { icon: ReactNode; title: string; hint: string; action?: ReactNode }) {
  return (
    <div
      data-testid="list-state"
      className="flex min-h-64 flex-col items-center justify-center gap-2.5 rounded-xl border border-border bg-card px-6 py-12 text-center"
    >
      <span className="text-muted-foreground/60">{icon}</span>
      <p className="text-base font-bold text-foreground">{title}</p>
      <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">{hint}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}
