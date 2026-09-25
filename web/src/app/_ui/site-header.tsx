'use client'
import Link from 'next/link'
import { useState } from 'react'
import { IconMenu2 } from '@tabler/icons-react'
import { AccountMenu } from '@/app/_ui/account-menu'
import { Button } from '@/app/_ui/ui/button'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/app/_ui/ui/sheet'
import { cn } from '@/shared/cn'

type NavItem = { href: string; label: string }

/**
 * 前台導覽列（原型 `components/public/site-header.tsx`）：
 * 左 logo＋「專題管理平台」，選單靠右（hover 橘線），最右一顆橘色主要按鈕；
 * 登入後多一個頭像下拉（我的帳號、後台、登出）。窄螢幕收成右側抽屜。
 */
export function SiteHeader({
  nav,
  current,
  viewer,
  signOutFormId,
}: {
  nav: readonly NavItem[]
  current?: string
  /** 沒登入是 null；登入了帶角色名與後台入口。 */
  viewer: { roleLabel: string; name?: string; workbench: { href: string; label: string } } | null
  signOutFormId: string
}) {
  const [open, setOpen] = useState(false)

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background">
      <div className="mx-auto flex h-20 w-full max-w-[1600px] items-center gap-6 px-5 md:px-8 xl:px-12">
        <Link href="/" className="flex shrink-0 items-center gap-3.5">
          {/* 系網 logo 是靜態 PNG；不走 next/image（它會輸出 style 屬性，被正式站 CSP 擋）。 */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/fju-im-logo.png" alt="輔仁大學資訊管理學系" width={180} height={44} className="h-11 w-auto" />
          <span aria-hidden className="hidden h-8 w-px bg-border sm:block" />
          <span className="hidden text-[17px] font-bold sm:block">專題管理平台</span>
        </Link>

        <nav className="ml-auto hidden items-center gap-6 lg:flex xl:gap-8" aria-label="主導覽">
          {nav.map((item) => {
            const active = current === item.href
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'nav-ink inline-flex items-center gap-1 py-7 text-[16px] font-semibold whitespace-nowrap transition-colors duration-300 hover:text-primary',
                  active ? 'text-primary' : 'text-foreground',
                )}
              >
                {item.label}
              </Link>
            )
          })}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-3 lg:ml-4 xl:ml-6">
          {viewer ? (
            // 登入後的「回後台」＋頭像要到 lg 才放得下（跟主導覽同一個斷點）；更窄時都收在右側抽屜裡，
            // 不然 640–1023px 三樣擠在一起會把漢堡推出畫面（#277 審查建議 1）。
            <>
              <Link href={viewer.workbench.href} className="btn-fju hidden h-10.5 px-5 text-[15px] whitespace-nowrap lg:inline-flex">
                {viewer.workbench.label}
              </Link>
              <span className="hidden lg:inline-flex">
                <AccountMenu
                  roleLabel={viewer.roleLabel}
                  name={viewer.name}
                  signOutFormId={signOutFormId}
                  links={[
                    { href: '/account', label: '我的帳號', icon: 'account' },
                    { href: viewer.workbench.href, label: viewer.workbench.label, icon: 'workbench' },
                  ]}
                />
              </span>
            </>
          ) : (
            <Link href="/login" className="btn-fju hidden h-10.5 px-5.5 text-[15px] sm:inline-flex">
              登入
            </Link>
          )}

          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger
              render={
                <Button variant="ghost" size="icon-lg" className="lg:hidden" aria-label="開啟選單">
                  <IconMenu2 className="size-5" />
                </Button>
              }
            />
            <SheetContent side="right" className="w-80">
              <SheetTitle className="px-4 pt-4 text-base">選單</SheetTitle>
              <nav className="mt-2 flex flex-col p-2" aria-label="主導覽（手機）">
                {nav.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setOpen(false)}
                    aria-current={current === item.href ? 'page' : undefined}
                    className="rounded-lg px-3 py-3 text-[15px] font-semibold hover:bg-accent aria-[current=page]:text-primary"
                  >
                    {item.label}
                  </Link>
                ))}
                {viewer ? (
                  <>
                    <Link href={viewer.workbench.href} onClick={() => setOpen(false)} className="mt-2 rounded-lg px-3 py-3 text-[15px] font-semibold text-primary">
                      {viewer.workbench.label}
                    </Link>
                    <Link href="/account" onClick={() => setOpen(false)} className="rounded-lg px-3 py-3 text-[15px]">
                      我的帳號
                    </Link>
                    <button type="submit" form={signOutFormId} className="rounded-lg px-3 py-3 text-left text-[15px] text-muted-foreground">
                      登出
                    </button>
                  </>
                ) : (
                  <>
                    <Link href="/login" onClick={() => setOpen(false)} className="mt-2 rounded-lg px-3 py-3 text-[15px] font-semibold text-primary">
                      登入
                    </Link>
                    <Link href="/register" onClick={() => setOpen(false)} className="rounded-lg px-3 py-3 text-[15px]">
                      註冊
                    </Link>
                  </>
                )}
              </nav>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  )
}
