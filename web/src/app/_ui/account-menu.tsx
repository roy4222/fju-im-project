'use client'
import Link from 'next/link'
import { IconChevronDown, IconLayoutDashboard, IconLogout, IconUserCircle, IconWorld } from '@tabler/icons-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/app/_ui/ui/dropdown-menu'
import { cn } from '@/shared/cn'

export type AccountLink = { href: string; label: string; icon: 'account' | 'workbench' | 'site' }

const ICONS = { account: IconUserCircle, workbench: IconLayoutDashboard, site: IconWorld } as const

/**
 * 右上角的帳號選單（原型 `site-header`／`dashboard-header` 的頭像下拉）。
 *
 * 目前拿不到姓名（Actor 只有角色與狀態），頭像先放角色的第一個字、旁邊寫角色。
 * 「登出」是 `<button form=…>`，送的是外殼裡那張看不見的登出表單（Server Action 的 POST）。
 */
export function AccountMenu({
  roleLabel,
  links,
  signOutFormId,
  compact = false,
}: {
  roleLabel: string
  links: readonly AccountLink[]
  signOutFormId: string
  /** 後台頂列：頭像小一號。 */
  compact?: boolean
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label="帳號選單"
            className={cn(
              'inline-flex items-center gap-2 rounded-lg py-1 pr-2 pl-1 transition-colors hover:bg-accent',
              compact ? 'h-9' : '',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'inline-flex items-center justify-center rounded-full bg-primary-subtle font-bold text-primary-on-subtle',
                compact ? 'size-7 text-xs' : 'size-8.5 text-sm',
              )}
            >
              {roleLabel.slice(0, 1)}
            </span>
            <span className="hidden text-[13px] font-semibold whitespace-nowrap sm:inline">{roleLabel}</span>
            <IconChevronDown className="hidden size-3.5 text-muted-foreground sm:inline" aria-hidden />
          </button>
        }
      />
      <DropdownMenuContent align="end" className="w-56 p-1.5">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-xs text-muted-foreground">{roleLabel}</DropdownMenuLabel>
          {links.map((link) => {
            const Icon = ICONS[link.icon]
            return (
              <DropdownMenuItem key={link.href} className="h-9 px-2.5 text-[14px]" render={<Link href={link.href} />}>
                <Icon aria-hidden /> {link.label}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="h-9 w-full px-2.5 text-[14px]" render={<button type="submit" form={signOutFormId} />}>
          <IconLogout aria-hidden /> 登出
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
