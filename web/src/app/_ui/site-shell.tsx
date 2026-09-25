import Link from 'next/link'
import { cookies } from 'next/headers'
import type { ReactNode } from 'react'
import type { ResolvedActor } from '@/application/accounts'
import { DashboardFrame } from '@/app/_ui/dashboard-frame'
import { homeFor, shellViewer } from '@/app/_ui/guard'
import { InboxBell } from '@/app/_ui/inbox-bell'
import { SiteHeader } from '@/app/_ui/site-header'
import { SignOutForm } from '@/app/_ui/sign-out'
import { SIDEBAR_COOKIE_NAME, sidebarOpenFromCookie } from '@/app/_ui/sidebar-cookie'
import { checkStatus } from '@/composition/accounts'
import { cn } from '@/shared/cn'

/**
 * 前台主導覽（票 16；產品模組 09 §9.2；項目與順序照原型 `site-header.tsx`）。
 *
 * 原型訪客看到：最新公告、專題規則、優秀專題、榮譽榜；登入後：最新公告、專題規則、歷屆專題、產學合作、檔案下載。
 * 優秀專題、榮譽榜、歷屆專題、競賽資訊的頁面還沒做，先不列（做好再照原型的位置補上）。
 */
const GUEST_NAV: readonly NavItem[] = [
  { href: '/news', label: '最新公告' },
  { href: '/rules', label: '專題規則' },
]
const MEMBER_NAV: readonly NavItem[] = [
  ...GUEST_NAV,
  { href: '/industry', label: '產學合作' },
  { href: '/files', label: '檔案下載' },
]

const SIGN_OUT_FORM_ID = 'site-sign-out'

/**
 * 看得到「登入後」前台內容的人（導覽的產學、檔案，首頁的我的工作、歷屆專題、我的入口）：
 * 已開通、進得了自己後台的人：過得了 business 狀態閘門（臨時密碼還沒改的不算），而且有角色。
 * 待審核、必須先改密碼的人雖然登入了，跟訪客一樣（那些頁他還打不開）。
 * 導覽與首頁共用這一個判斷。
 */
export function isMember(actor: ResolvedActor): boolean {
  return actor.kind === 'authenticated' && checkStatus(actor, 'business') === null && homeFor(actor).startsWith('/dashboard/')
}

/** 右上角要顯示的身分與「回後台」入口（原型 `workbenchLabel`）。 */
function viewerOf(actor: ResolvedActor): { roleLabel: string; name?: string; workbench: { href: string; label: string } } | null {
  if (actor.kind !== 'authenticated') return null
  const href = homeFor(actor)
  const name = actor.displayName
  if (href === '/dashboard/admin') return { roleLabel: '系辦', name, workbench: { href, label: '管理後台' } }
  if (href === '/dashboard/teacher') return { roleLabel: '老師', name, workbench: { href, label: '老師工作台' } }
  if (href === '/dashboard/student') return { roleLabel: '學生', name, workbench: { href, label: '我的專題事務' } }
  return { roleLabel: '待審核', name, workbench: { href, label: '申請進度' } }
}

/**
 * 公開頁與登入前頁面的外殼（原型 `(public)/layout.tsx`）：頂部導覽列、內容、深藍頁尾。
 *
 * 右上角看登入狀態：沒登入給橘色「登入」，登入了給「回後台」按鈕與頭像下拉。
 * `current` 是目前所在的前台區塊，導覽會標出來。
 * `bare`：內容自己決定寬度與留白（首頁、登入卡片）；預設是置中的內容欄。
 */
export async function SiteShell({ children, current, bare = false }: { children: ReactNode; current?: string; bare?: boolean }) {
  const actor = await shellViewer()
  const viewer = viewerOf(actor)
  const nav = isMember(actor) ? MEMBER_NAV : GUEST_NAV
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <SiteHeader nav={nav} current={current} viewer={viewer} signOutFormId={SIGN_OUT_FORM_ID} />
      {viewer ? <SignOutForm id={SIGN_OUT_FORM_ID} /> : null}
      <main className={cn('flex-1 overflow-x-clip', bare ? '' : 'mx-auto w-full max-w-6xl px-5 py-10')}>{children}</main>
      <SiteFooter viewer={viewer} nav={nav} />
    </div>
  )
}

/** 深藍頁尾（原型 `site-footer.tsx`）：系所資訊＋兩欄連結。只連 web 已經有的頁。 */
function SiteFooter({ viewer, nav }: { viewer: ReturnType<typeof viewerOf>; nav: readonly NavItem[] }) {
  const columns = [
    { title: '內容', links: nav },
    {
      title: '使用',
      links: viewer
        ? [
            { href: '/account', label: '我的帳號' },
            { href: viewer.workbench.href, label: viewer.workbench.label },
          ]
        : [
            { href: '/login', label: '登入' },
            { href: '/register', label: '註冊' },
          ],
    },
  ]
  return (
    <footer className="bg-ink text-ink-foreground">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-14 md:grid-cols-[1.6fr_1fr_1fr]">
        <div>
          <p className="text-lg font-bold">輔仁大學資訊管理學系</p>
          <p className="mt-3 text-[13px] leading-loose opacity-85">
            242 新北市新莊區中正路 510 號 利瑪竇大樓
            <br />
            電話 +886-2-2905-2696
            <br />
            專題相關事務請洽系辦公室
          </p>
        </div>
        {columns.map((col) => (
          <nav key={col.title} aria-label={`頁尾：${col.title}`}>
            <p className="text-sm font-bold">{col.title}</p>
            <ul className="mt-3 space-y-2.5">
              {col.links.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="text-sm opacity-85 transition-opacity hover:underline hover:opacity-100">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="border-t border-white/15">
        <div className="mx-auto max-w-6xl px-5 py-4 text-xs opacity-75">© 2026 輔仁大學資訊管理學系</div>
      </div>
    </footer>
  )
}

/**
 * 登入、註冊這類「只有一張卡」的頁面（原型 `auth-card.tsx` 的灰底置中區）。
 * 外面一樣有前台導覽列與頁尾。卡片本身用 `AuthCard`（primitives）。
 *
 * `wide` 給欄位比較多的表單（註冊、等待審核頁）：跟原型的 560px 卡片一樣寬。
 */
export async function NarrowShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <SiteShell bare>
      <div className="flex min-h-[720px] items-center justify-center bg-muted/50 px-5 py-16">
        <div className={cn('flex w-full flex-col gap-4', wide ? 'max-w-[560px]' : 'max-w-[440px]')}>{children}</div>
      </div>
    </SiteShell>
  )
}

export type NavItem = { href: string; label: string }

/**
 * 後台外殼：側欄＋頂列＋內容（原型 `dashboard/[role]/layout.tsx`）。
 *
 * 每一頁自己呼叫（角色守衛在頁面，見 `_nav.ts`）；`current` 是側欄要標出來的那一項。
 * 外觀在 `DashboardFrame`（client：側欄收合、手機抽屜、帳號下拉），
 * 這裡只放伺服器才做得到的：通知鈴鐺的未讀數、登出表單。
 */
export async function DashboardShell({
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
  const base = current.split('/').slice(0, 3).join('/')
  const signOutFormId = 'dashboard-sign-out'
  // 頭像的姓名：跟鈴鐺共用同一次身分解析（`shellViewer`），不另外查；只讀本人這一列。
  const [viewer, jar] = await Promise.all([shellViewer(), cookies()])
  const name = viewer.kind === 'authenticated' ? viewer.displayName : undefined
  // 側欄上次是收合還是展開（瀏覽器切換時寫的 cookie）。
  const sidebarOpen = sidebarOpenFromCookie(jar.get(SIDEBAR_COOKIE_NAME)?.value)
  return (
    <>
      <SignOutForm id={signOutFormId} />
      <DashboardFrame
        roleLabel={roleLabel}
        userName={name}
        sidebarOpen={sidebarOpen}
        items={items}
        current={current}
        homeHref={base}
        // 通知鈴鐺（票 12）：通知匣在各角色後台底下的 /inbox。
        bell={<InboxBell href={`${base}/inbox`} />}
        signOutFormId={signOutFormId}
      >
        {children}
      </DashboardFrame>
    </>
  )
}
