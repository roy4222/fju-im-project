'use client'
import Link from 'next/link'
import { IconChevronDown } from '@tabler/icons-react'
import { usePathname } from 'next/navigation'
import { useEffect, useState, type ComponentType, type ReactNode } from 'react'
import { loadBrokenFx, loadEasterEgg, loadFlyingButton, loadHomePixel, loadStaggeredMenu } from '@/app/_ui/dash-theme'
import * as eggRules from '@/app/_ui/easter-egg-rules'
import { useBrokenFx } from '@/app/_ui/fx/fuzzy-text'
import { FX_QUERY, PIXEL_TOUCH_QUERY } from '@/app/_ui/fx/media-query'
import { cn } from '@/shared/cn'

/**
 * 一個導覽項目。`children` 是下拉（原型：最新公告 → 公告列表／競賽資訊；歷屆專題 → 一覽／優秀專題／榮譽榜）；
 * `match` 是「目前在哪些路徑底下時這一項要標亮」，沒給就是自己的 `href`。
 */
export type NavItem = {
  readonly href: string
  readonly label: string
  readonly children?: readonly { readonly href: string; readonly label: string }[]
  readonly match?: readonly string[]
}

function isActive(item: NavItem, current: string | undefined): boolean {
  if (!current) return false
  return (item.match ?? [item.href]).some((p) => current === p || current.startsWith(`${p}/`))
}

/**
 * 首頁橫幅 Pixel（C4-08）：頁面有 `[data-home-pixel]` 記號、裝置有滑鼠或觸控而且沒開減少動態，才下載引擎並插入像素層。
 * 掛在頁首而不是首頁：首頁有自己的前端元件時，打包工具會把頁首共用程式重複打包一份給首頁（約 1.6 KB）。
 */
function useHomePixel(pathname: string) {
  useEffect(() => {
    const marker = document.querySelector('[data-home-pixel]')
    if (!marker) return
    const mode = matchMedia(FX_QUERY).matches ? 'always' : matchMedia(PIXEL_TOUCH_QUERY).matches ? 'tap' : null
    if (!mode) return
    let stop: (() => void) | undefined
    let dead = false
    void loadHomePixel().then((m) => {
      if (!dead) stop = m.mountHomeHeroPixel(marker, mode)
    })
    return () => {
      dead = true
      stop?.()
    }
  }, [pathname])
}

type MenuPanel = ComponentType<{ open: boolean; onClose: () => void; children: ReactNode }>

/**
 * 手機選單的觸發鈕（< 1024；登入後到 1280，設計方案 §8 原因 C：1024～1279 放不下「我的後台」）。
 * 面板（`staggered-menu.tsx`＋CSS）第一次點開才下載，首載只有這顆按鈕（主腦裁定 C4-09 ESCALATE 1）；載過就留著，之後開關不再下載。
 */
function MenuTrigger({ wide, children }: { wide: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [Panel, setPanel] = useState<{ C: MenuPanel } | null>(null)

  function onClick() {
    if (Panel) return setOpen(true)
    void loadStaggeredMenu().then((m) => {
      setPanel({ C: m.StaggeredMenu })
      setOpen(true)
    })
  }

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        aria-expanded={open}
        aria-label={open ? '關閉選單' : '開啟選單'}
        className={cn(
          'sm-trigger inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[15px] font-semibold pointer-coarse:min-h-11 hover:bg-accent',
          wide ? 'xl:hidden' : 'lg:hidden',
        )}
      >
        選單
        <span aria-hidden className={cn('text-lg leading-none transition-transform duration-300', open && 'rotate-45')}>
          +
        </span>
      </button>
      {Panel ? (
        <Panel.C open={open} onClose={() => setOpen(false)}>
          {children}
        </Panel.C>
      ) : null}
    </>
  )
}

/**
 * 前台導覽列（原型 `components/public/site-header.tsx`）：
 * 左 logo＋「專題管理平台」，選單靠右（hover 橘線），最右一顆橘色主要按鈕。
 * 登入後那顆按鈕是「我的後台」，沒有頭像下拉：前台對每個人都一樣，我的帳號、切換後台、登出都在後台（C2-14）。
 * 窄螢幕（< 1024）收成 Staggered Menu（`MenuTrigger`＋點開才下載的 `staggered-menu.tsx`）；首頁 logo 連點 10 次有彩蛋（`easter-egg.tsx`，點了才下載）。
 */
export function SiteHeader({
  nav,
  current,
  viewer,
  signOutFormId,
  registrationOpen,
}: {
  nav: readonly NavItem[]
  current?: string
  /** 沒登入是 null；登入了帶後台入口（待審核是申請進度、臨時密碼沒改是更改密碼）。 */
  viewer: { workbench: { href: string; label: string } } | null
  signOutFormId: string
  /** 註冊關閉時（設計方案 §5）手機選單不列「註冊」；值由伺服器端的 `SiteShell` 決定。 */
  registrationOpen: boolean
}) {
  // 404／403 壞掉頁的特效（C4-05）：頁面有 `[data-broken-fx]` 才載引擎。
  useBrokenFx(loadBrokenFx)
  const pathname = usePathname()
  useHomePixel(pathname)

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background">
      <div className="mx-auto flex h-20 w-full max-w-[1600px] items-center gap-6 px-5 md:px-8 xl:px-12">
        {/* logo 彩蛋（`easter-egg.tsx`）：首頁的滑鼠／觸控點擊不導向、交給點了才下載的計數；`key` 讓換頁就歸零。 */}
        <Link
          key={pathname}
          href="/"
          data-egg-count="0"
          onClick={(e) => {
            if (!eggRules.shouldCountClick(pathname, e)) return
            e.preventDefault()
            const logo = e.currentTarget
            void loadEasterEgg().then((m) => m.eggLogoClick(logo, eggRules, loadFlyingButton))
          }}
          className="flex shrink-0 items-center gap-3.5"
        >
          {/* 系網 logo 是靜態 PNG；不走 next/image（它會輸出 style 屬性，被正式站 CSP 擋）。 */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/fju-im-logo.png" alt="輔仁大學資訊管理學系" width={180} height={44} className="h-11 w-auto" />
          <span aria-hidden className="hidden h-8 w-px bg-border sm:block" />
          <span className="hidden text-[17px] font-bold sm:block">專題管理平台</span>
        </Link>

        <nav className="ml-auto hidden items-center gap-6 lg:flex xl:gap-8" aria-label="主導覽">
          {nav.map((item) => {
            const active = isActive(item, current)
            return (
              <div key={item.label} className="group relative">
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'nav-ink inline-flex items-center gap-1 py-7 text-[16px] font-semibold whitespace-nowrap transition-colors duration-300 hover:text-primary',
                    active ? 'text-primary' : 'text-foreground',
                  )}
                >
                  {item.label}
                  {item.children ? <IconChevronDown className="size-3.5" aria-hidden /> : null}
                </Link>
                {item.children ? (
                  // 系網樣式的下拉：白底、上緣 3px 橘線；hover 或鍵盤 focus 展開。
                  <div className="nav-dropdown invisible absolute top-full left-0 z-20 flex min-w-60 flex-col border-t-[3px] border-primary bg-popover opacity-0 shadow-[0_6px_18px_rgba(0,0,0,0.12)] group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
                    {item.children.map((c) => (
                      <Link
                        key={c.href}
                        href={c.href}
                        className="border-b border-border px-4.5 py-3.5 text-[15px] text-foreground transition-[background-color,color,padding-left] duration-200 hover:bg-primary-subtle hover:pl-6 hover:text-primary-on-subtle"
                      >
                        {c.label}
                      </Link>
                    ))}
                  </div>
                ) : null}
              </div>
            )
          })}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-3 lg:ml-4 xl:ml-6">
          {viewer ? (
            // 1280 起才放頂列：1024 登入後放不下（設計方案 §8 原因 C），1024～1279 收在選單裡；訪客的主導覽在 1024 照常展開。
            <Link href={viewer.workbench.href} className="btn-fju hidden h-10.5 px-5 text-[15px] whitespace-nowrap xl:inline-flex">
              {viewer.workbench.label}
            </Link>
          ) : (
            <Link href="/login" className="btn-fju hidden h-10.5 px-5.5 text-[15px] sm:inline-flex">
              登入
            </Link>
          )}

          <MenuTrigger wide={viewer !== null}>
            <nav className="mt-2 flex flex-col p-2" aria-label="主導覽（手機）">
              {nav.flatMap((item) => [
                <Link
                  key={item.label}
                  href={item.href}
                  aria-current={isActive(item, current) ? 'page' : undefined}
                  className="rounded-lg px-3 py-3 text-[15px] font-semibold hover:bg-accent aria-[current=page]:text-primary"
                >
                  {item.label}
                </Link>,
                ...(item.children ?? []).map((c) => (
                  <Link
                    key={`${item.label}-${c.href}`}
                    href={c.href}
                    className="rounded-lg py-2.5 pr-3 pl-7 text-sm text-muted-foreground hover:bg-accent"
                  >
                    {c.label}
                  </Link>
                )),
              ])}
              {viewer ? (
                <>
                  <Link href={viewer.workbench.href} className="mt-2 rounded-lg px-3 py-3 text-[15px] font-semibold text-primary">
                    {viewer.workbench.label}
                  </Link>
                  <button type="submit" form={signOutFormId} className="rounded-lg px-3 py-3 text-left text-[15px] text-muted-foreground">
                    登出
                  </button>
                </>
              ) : (
                <>
                  <Link href="/login" className="mt-2 rounded-lg px-3 py-3 text-[15px] font-semibold text-primary">
                    登入
                  </Link>
                  {registrationOpen ? (
                    <Link href="/register" className="rounded-lg px-3 py-3 text-[15px]">
                      註冊
                    </Link>
                  ) : null}
                </>
              )}
              </nav>
          </MenuTrigger>
        </div>
      </div>
    </header>
  )
}
