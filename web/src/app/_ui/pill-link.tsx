'use client'
import Link, { useLinkStatus } from 'next/link'
import type { ReactNode } from 'react'
import { cn } from '@/shared/cn'

function Pending() {
  const { pending } = useLinkStatus()
  return <span aria-hidden className={cn('pill-dot', pending && 'is-pending')} />
}

/**
 * pill 篩選（連結版，狀態在 searchParams；原型 `components/public/pill-link.tsx`）。
 * 按下有縮放回饋、換頁中有小點提示。深藍是一般篩選、橘是要特別提醒的那一顆。
 */
export function PillLink({
  href,
  active,
  children,
  tone = 'navy',
}: {
  href: string
  active: boolean
  children: ReactNode
  tone?: 'navy' | 'brand'
}) {
  const activeCls = tone === 'brand' ? 'border-primary bg-primary text-primary-foreground' : 'border-ink bg-ink text-ink-foreground'
  const idleCls =
    tone === 'brand'
      ? 'border-primary text-primary hover:bg-primary-subtle'
      : 'border-border text-foreground hover:border-ink/40 hover:bg-accent'
  return (
    <Link
      href={href}
      scroll={false}
      className={cn(
        'press relative inline-flex h-9 items-center gap-1.5 rounded-full border px-4 text-sm font-semibold transition-[background-color,border-color,color,transform,box-shadow] duration-200',
        active ? `${activeCls} shadow-[0_2px_8px_rgba(0,51,102,0.18)]` : idleCls,
      )}
      aria-current={active ? 'true' : undefined}
    >
      {children}
      <Pending />
    </Link>
  )
}
