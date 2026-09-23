import Link from 'next/link'
import type { ReactNode } from 'react'
import { cn } from '@/shared/cn'

/**
 * 公開頁與登入前頁面的外殼：頂部一條，內容單欄置中。
 */
export function SiteShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
          <Link href="/" className="text-sm font-semibold text-ink">
            輔仁大學資訊管理學系專題管理平台
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            <Link href="/login" className="rounded-md px-3 py-1.5 text-ink hover:bg-muted">
              登入
            </Link>
            <Link
              href="/register"
              className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground hover:bg-primary/90"
            >
              註冊
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
    </div>
  )
}

/** 登入、註冊這類「只有一張卡」的頁面。 */
export function NarrowShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-surface">
      <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10">
        <Link href="/" className="mb-6 block text-center text-sm font-semibold text-ink">
          輔仁大學資訊管理學系專題管理平台
        </Link>
        {children}
      </div>
    </div>
  )
}

export type NavItem = { href: string; label: string }

/**
 * 後台外殼：側欄 ＋ 內容。
 *
 * 行動版（< md）側欄收成一個 `<details>` 下拉：不需要任何 client JS，
 * 也就不必為了一個選單放寬 CSP。桌機版側欄固定在左邊。
 */
export function DashboardShell({
  roleLabel,
  items,
  current,
  children,
}: {
  roleLabel: string
  items: readonly NavItem[]
  current: string
  children: ReactNode
}) {
  return (
    <div className="min-h-dvh bg-surface md:grid md:grid-cols-[16rem_1fr]">
      <aside className="border-b border-border bg-ink text-ink-foreground md:border-b-0 md:border-r md:border-border">
        <div className="flex items-center justify-between gap-2 px-4 py-3">
          <Link href="/" className="text-sm font-semibold">
            資管系專題平台
          </Link>
          <span className="rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground">
            {roleLabel}
          </span>
        </div>

        {/* 行動版：收合選單。桌機版：md 以上直接展開，details 的開合不影響。 */}
        <details className="md:hidden" name="dashboard-nav">
          <summary className="cursor-pointer list-none border-t border-white/10 px-4 py-2 text-sm">
            選單
          </summary>
          <NavList items={items} current={current} />
        </details>
        <div className="hidden md:block">
          <NavList items={items} current={current} />
        </div>

        <div className="border-t border-white/10 px-4 py-3 text-sm">
          <Link href="/account" className="block rounded-md px-2 py-1.5 hover:bg-white/10">
            我的帳號
          </Link>
        </div>
      </aside>

      <div className="min-w-0">
        <main className="mx-auto max-w-4xl px-4 py-8">{children}</main>
      </div>
    </div>
  )
}

function NavList({ items, current }: { items: readonly NavItem[]; current: string }) {
  return (
    <nav className="px-2 py-2">
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={item.href === current ? 'page' : undefined}
              className={cn(
                'block rounded-md px-3 py-2 text-sm',
                item.href === current ? 'bg-primary text-primary-foreground' : 'hover:bg-white/10',
              )}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}
