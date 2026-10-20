import Link from 'next/link'
import { cookies } from 'next/headers'
import type { ReactNode } from 'react'
import type { ResolvedActor } from '@/application/accounts'
import { UserAvatar } from '@/app/_ui/avatar/user-avatar'
import { DashboardFrame } from '@/app/_ui/dashboard-frame'
import type { NavItem } from '@/app/dashboard/_nav'
import { homeFor, renderActor, shellViewer } from '@/app/_ui/guard'
import { InboxBell } from '@/app/_ui/inbox-bell'
import { SiteHeader, type NavItem as HeaderNavItem } from '@/app/_ui/site-header'
import { SignOutForm } from '@/app/_ui/sign-out'
import { feItem, frontEditScope } from '@/app/_ui/front-edit/mark'
import { badgeMap, roleOfBase } from '@/app/_ui/nav-badge-rules'
import { roleSwitchLinks } from '@/app/_ui/role-switch'
import { navBadgeCounts } from '@/app/_ui/nav-badges'
import { SIDEBAR_COOKIE_NAME, sidebarOpenFromCookie } from '@/app/_ui/sidebar-cookie'
import { resolveSiteContact, type SiteContact } from '@/app/_ui/site-contact'
import { checkStatus, isRegistrationOpen } from '@/composition/accounts'
import { loadSiteTexts } from '@/composition/site'
import { cn } from '@/shared/cn'

/**
 * 前台主導覽（產品模組 09 §9.2「首頁 hero 與導覽」；順序照原型 `components/public/site-header.tsx`）：
 * - 訪客：最新公告（下拉：公告列表／競賽資訊）、專題規則、優秀專題、榮譽榜——優秀專題與榮譽榜提到頂層。
 * - 登入後：最新公告（同上）、專題規則、專題時程（C3 §9.6）、歷屆專題（下拉：歷屆專題一覽／優秀專題／榮譽榜）、產學合作、檔案下載。
 */
const NEWS_NAV: HeaderNavItem = {
  href: '/news',
  label: '最新公告',
  children: [
    { href: '/news', label: '公告列表' },
    { href: '/competitions', label: '競賽資訊' },
  ],
  match: ['/news', '/competitions'],
}
const RULES_NAV: HeaderNavItem = { href: '/rules', label: '專題規則' }

const GUEST_NAV: readonly HeaderNavItem[] = [
  NEWS_NAV,
  RULES_NAV,
  { href: '/projects/featured', label: '優秀專題', match: ['/projects'] },
  { href: '/honors', label: '榮譽榜' },
]

const MEMBER_NAV: readonly HeaderNavItem[] = [
  NEWS_NAV,
  RULES_NAV,
  { href: '/timeline', label: '專題時程' },
  {
    href: '/projects',
    label: '歷屆專題',
    children: [
      { href: '/projects', label: '歷屆專題一覽' },
      { href: '/projects/featured', label: '優秀專題' },
      { href: '/honors', label: '榮譽榜' },
    ],
    match: ['/projects', '/honors'],
  },
  { href: '/industry', label: '產學合作' },
  { href: '/files', label: '檔案下載' },
]

/** 頁尾的一個連結（後台側欄的 `NavItem` 要圖示，頁尾不用）。 */
export type FooterLink = { href: string; label: string }

/** 頁尾「內容」欄（原型 site-footer）：導覽攤平、不重複。 */
function footerLinks(nav: readonly HeaderNavItem[]): FooterLink[] {
  const seen = new Set<string>()
  const links: FooterLink[] = []
  for (const item of nav) {
    for (const l of item.children ?? [item]) {
      if (seen.has(l.href)) continue
      seen.add(l.href)
      links.push({ href: l.href, label: l.href === '/news' ? '最新公告' : l.label })
    }
  }
  return links
}

const SIGN_OUT_FORM_ID = 'site-sign-out'

/**
 * 看得到「登入後」前台內容的人（導覽的產學、檔案，首頁的歷屆專題、我的入口）：
 * 已開通、進得了自己後台的人：過得了 business 狀態閘門（臨時密碼還沒改的不算），而且有角色。
 * 待審核、必須先改密碼的人雖然登入了，跟訪客一樣（那些頁他還打不開）。
 * 導覽與首頁共用這一個判斷。
 */
export function isMember(actor: ResolvedActor): boolean {
  return actor.kind === 'authenticated' && checkStatus(actor, 'business') === null && homeFor(actor).startsWith('/dashboard/')
}

/** 右上角的「回後台」入口：三個角色都叫「我的後台」，去 `homeFor` 那個後台（兼任的人在後台頭像選單切換）。 */
const WORKBENCHES: ReadonlySet<string> = new Set(['/dashboard/admin', '/dashboard/teacher', '/dashboard/student'])

type Viewer = { workbench: { href: string; label: string } }

/**
 * 後台帳號選單的頭像（SH-8）。頭像欄由身分解析同一句讀出來，不另查；外框是 client，
 * 所以在這裡（server）render 好，當 `ReactNode` 穿過 `DashboardFrame` 交給 `AccountMenu`。
 * 旁邊已經寫姓名，所以 `decorative`（`alt=""`）。
 */
function accountAvatar(actor: ResolvedActor): ReactNode {
  if (actor.kind !== 'authenticated') return null
  return (
    <UserAvatar
      user={{
        id: actor.userId,
        name: actor.displayName ?? '',
        avatarPreset: actor.avatarPreset ?? null,
        avatarFileId: actor.avatarFileId ?? null,
      }}
      size={32}
      decorative
    />
  )
}

function viewerOf(actor: ResolvedActor): Viewer | null {
  if (actor.kind !== 'authenticated') return null
  const href = homeFor(actor)
  if (!WORKBENCHES.has(href)) return { workbench: { href, label: '申請進度' } }
  // 臨時密碼還沒改：後台會被導去改密碼，右上角就直接給「更改密碼」。
  if (checkStatus(actor, 'business') === 'PASSWORD_CHANGE_REQUIRED') {
    return { workbench: { href: '/account/change-password', label: '更改密碼' } }
  }
  return { workbench: { href, label: '我的後台' } }
}

/**
 * 公開頁與登入前頁面的外殼（原型 `(public)/layout.tsx`）：頂部導覽列、內容、深藍頁尾。
 *
 * 右上角看登入狀態：沒登入給橘色「登入」，登入了只給「我的後台」按鈕（沒有頭像下拉，C2-14）。
 * `current` 是目前所在的前台區塊，導覽會標出來。
 * `bare`：內容自己決定寬度與留白（首頁、登入卡片）；預設是置中的內容欄。
 * `staticFooter`：頁尾用程式內預設的聯絡資料、不讀 `site_texts`、也不掛前台編輯標記。給根層 `not-found`
 * 用——它在根 layout 裡每次請求都會渲染，讀 DB 會讓全站每條路由都多一句查詢（C2-17 Review）。
 */
export async function SiteShell({
  children,
  current,
  bare = false,
  staticFooter = false,
}: {
  children: ReactNode
  current?: string
  bare?: boolean
  staticFooter?: boolean
}) {
  const actor = await shellViewer()
  const viewer = viewerOf(actor)
  const nav: readonly HeaderNavItem[] = isMember(actor) ? MEMBER_NAV : GUEST_NAV
  // 註冊關閉時（設計方案 §5），手機選單與頁尾都不列「註冊」。
  const registrationOpen = isRegistrationOpen()
  // 頁尾聯絡資料（C2-17）：系辦在前台改過就讀 `site_texts.footer_contact`，沒有就是程式內預設；同一次 render 跟首頁、隱私權頁共用一份查詢。
  const footerRow = staticFooter ? null : (await loadSiteTexts()).footer_contact
  const contact = resolveSiteContact(footerRow?.value)
  // 前台編輯標記（C2-16）：頁尾聯絡資料一則、只能改不能刪；只有系辦經 /office-edit 改寫進來才有。表單預填八欄＋目前版本。
  const contactMarks = feItem(staticFooter ? null : await frontEditScope(), {
    kind: 'footer_contact',
    id: 'footer_contact',
    rev: footerRow?.revision ?? 0,
    fields: {
      title: '頁尾聯絡資料',
      department: contact.department,
      address: contact.address,
      phone: contact.phone,
      siteLabel: contact.siteLabel,
      siteHref: contact.siteHref,
      slogan: contact.slogan,
      officeNote: contact.officeNote,
      industryNote: contact.industryNote,
    },
  })
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <SiteHeader
        nav={nav}
        current={current}
        viewer={viewer}
        signOutFormId={SIGN_OUT_FORM_ID}
        registrationOpen={registrationOpen}
      />
      {viewer ? <SignOutForm id={SIGN_OUT_FORM_ID} /> : null}
      <main className={cn('flex-1 overflow-x-clip', bare ? '' : 'mx-auto w-full max-w-6xl px-5 py-10')}>{children}</main>
      <SiteFooter viewer={viewer} nav={nav} registrationOpen={registrationOpen} contact={contact} contactMarks={contactMarks} />
    </div>
  )
}

/** 深藍頁尾（原型 `site-footer.tsx`）：系所資訊＋兩欄連結。只連 web 已經有的頁。 */
function SiteFooter({
  viewer,
  nav,
  registrationOpen,
  contact,
  contactMarks,
}: {
  viewer: ReturnType<typeof viewerOf>
  nav: readonly HeaderNavItem[]
  registrationOpen: boolean
  contact: SiteContact
  contactMarks: ReturnType<typeof feItem>
}) {
  const columns = [
    { title: '內容', links: footerLinks(nav) },
    {
      title: '使用',
      links: viewer
        ? [
            { href: viewer.workbench.href, label: viewer.workbench.label },
            { href: '/privacy', label: '隱私權政策' },
          ]
        : [
            { href: '/login', label: '登入' },
            ...(registrationOpen ? [{ href: '/register', label: '註冊' }] : []),
            { href: '/forgot-password', label: '忘記密碼' },
            { href: '/privacy', label: '隱私權政策' },
          ],
    },
  ]
  return (
    <footer className="bg-ink text-ink-foreground">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-14 md:grid-cols-[1.6fr_1fr_1fr]">
        <div {...contactMarks} data-testid="site-footer-contact">
          <p className="text-lg font-bold">{contact.department}</p>
          <p className="mt-3 text-[13px] leading-loose opacity-85">
            {contact.address}
            <br />
            電話{' '}
            <a href={contact.phoneHref} className="hover:underline">
              {contact.phone}
            </a>
            {contact.siteLabel ? (
              <>
                <br />
                系網{' '}
                <a href={contact.siteHref} className="hover:underline">
                  {contact.siteLabel}
                </a>
              </>
            ) : null}
            {[contact.slogan, contact.officeNote, contact.industryNote]
              .filter((line) => line !== '')
              .map((line) => (
                <span key={line} className="block">
                  {line}
                </span>
              ))}
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

// 側欄項目的型別在 `dashboard/_nav.ts`（SH-1a）；舊的 import 路徑照用。
export type { NavItem } from '@/app/dashboard/_nav'

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
  const role = roleOfBase(base)
  // 頭像的姓名：跟鈴鐺共用同一次身分解析（`renderActor`），不另外查；只讀本人這一列。
  // 側欄數字徽章（票 30）：只算本人、輪到本人做的事；`requireRole` 已先暖好快取，這裡拿到同一個（SH-P2）。
  const [viewer, jar, counts] = await Promise.all([renderActor(), cookies(), role ? navBadgeCounts(role) : {}])
  const name = viewer.kind === 'authenticated' ? viewer.displayName : undefined
  // 側欄上次是收合還是展開（瀏覽器切換時寫的 cookie）。
  const sidebarOpen = sidebarOpenFromCookie(jar.get(SIDEBAR_COOKIE_NAME)?.value)
  const badges = role ? badgeMap(role, items.map((i) => i.href), counts) : {}
  // 兼任角色（票 41）：帳號選單多「切換到另一個後台」。只是連結，權限仍由每一頁的 requireRole 判。
  const switchLinks = viewer.kind === 'authenticated' ? roleSwitchLinks(viewer.roles, role) : []
  return (
    <>
      <SignOutForm id={signOutFormId} />
      <DashboardFrame
        roleLabel={roleLabel}
        userName={name}
        sidebarOpen={sidebarOpen}
        badges={badges}
        items={items}
        current={current}
        homeHref={base}
        switchLinks={switchLinks}
        // 通知鈴鐺（票 12）：通知匣在各角色後台底下的 /inbox。
        bell={<InboxBell href={`${base}/inbox`} current={current} />}
        avatar={accountAvatar(viewer)}
        signOutFormId={signOutFormId}
      >
        {children}
      </DashboardFrame>
    </>
  )
}
