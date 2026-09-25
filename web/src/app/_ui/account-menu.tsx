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
 * 頭像放本人姓名的第一個字、旁邊寫姓名（Actor 解析身分時同一列順便帶回來，見 `actor-resolver.ts`）；
 * 取不到姓名才退回角色字。下拉頂端寫姓名與角色。
 * 「登出」是 `<button form=…>`，送的是外殼裡那張看不見的登出表單（Server Action 的 POST）。
 */
export function AccountMenu({
  roleLabel,
  name,
  links,
  signOutFormId,
  compact = false,
}: {
  roleLabel: string
  /** 本人姓名；沒有就顯示角色。 */
  name?: string
  links: readonly AccountLink[]
  signOutFormId: string
  /** 後台頂列：頭像小一號。 */
  compact?: boolean
}) {
  const shown = name ?? roleLabel
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
              {shown.slice(0, 1)}
            </span>
            <span className="hidden max-w-[10rem] truncate text-[13px] font-semibold whitespace-nowrap sm:inline">{shown}</span>
            <IconChevronDown className="hidden size-3.5 text-muted-foreground sm:inline" aria-hidden />
          </button>
        }
      />
      <DropdownMenuContent align="end" className="w-56 p-1.5">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-0.5 py-1.5">
            {name ? <span className="truncate text-sm font-semibold text-foreground">{name}</span> : null}
            <span className="text-xs text-muted-foreground">{roleLabel}</span>
          </DropdownMenuLabel>
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
