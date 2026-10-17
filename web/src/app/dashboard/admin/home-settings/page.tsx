import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { requireRole } from '@/app/_ui/guard'
import { Card } from '@/app/_ui/primitives'
import { PageTitle } from '@/app/_ui/dashboard/primitives'
import { DashboardShell } from '@/app/_ui/site-shell'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { AdminTabs } from '@/app/dashboard/admin/_tabs'
import { HomeSettingsForm } from '@/app/dashboard/admin/home-settings/home-settings-form'
import { getHomeSettingsQuery, HERO_UPLOAD, HOME_DEFAULTS, HOME_LIMITS } from '@/composition/site'
import { formatTaipeiMinute } from '@/shared/time'

export const metadata = { title: '首頁設定｜資管系專題平台' }

/** 設定的四個分頁（設計方案 §3.6；D-1 `h1` 用側欄名「設定」）。 */
const SETTINGS_TABS = [
  { href: '/dashboard/admin/cohorts', label: '屆別' },
  { href: '/dashboard/admin/timeline', label: '時間軸' },
  { href: '/dashboard/admin/home-settings', label: '首頁設定' },
  { href: '/dashboard/admin/audit', label: '操作紀錄' },
] as const

/**
 * 首頁設定（第三波 W3；設計方案 §3，Q18、Q32）：首頁最上面的大圖與兩行標語，存了就生效。
 *
 * 聯絡卡、快速入口、頁尾、hero 上方小字與兩顆按鈕不在這裡（頁面外框，程式直接改）。
 * AD-15：掛「設定」分頁列，說明只留第一句（`pages.spec` 指紋）；表單不動。
 */
export default async function AdminHomeSettingsPage() {
  await requireRole('/dashboard/admin/home-settings', 'admin')
  const settings = await getHomeSettingsQuery().current()

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/home-settings">
      <PageTitle title="設定" description="前台首頁最上面的大圖與兩行標語。" />
      <div className="mt-3">
        <AdminTabs label="設定分頁" current="/dashboard/admin/home-settings" items={SETTINGS_TABS} />
      </div>
      <Card
        title="首頁大圖與標語"
        description="會出現在前台首頁的最上方（所有人都看得到，包含沒登入的訪客）。"
      >
        <p className="mb-4 text-sm">
          <Link href="/" className="font-semibold text-primary hover:underline" target="_blank" rel="noopener">
            開新分頁看前台首頁
          </Link>
          {settings ? (
            <span className="ml-2 text-xs text-muted-foreground" data-testid="home-settings-updated">
              上次更新：{formatTaipeiMinute(settings.updatedAt)}
              {settings.updatedByName ? `・${settings.updatedByName}` : ''}
            </span>
          ) : (
            <span className="ml-2 text-xs text-muted-foreground">目前用的是預設的照片與標語。</span>
          )}
        </p>
        <HomeSettingsForm
          revision={settings?.revision ?? 0}
          requestId={randomUUID()}
          resetRequestId={randomUUID()}
          saved={{
            heroFileId: settings?.heroFileId ?? null,
            heroAlt: settings?.heroAlt ?? '',
            line1: settings?.line1 ?? '',
            line2: settings?.line2 ?? '',
          }}
          defaults={{ heroSrc: HOME_DEFAULTS.heroSrc, line1: HOME_DEFAULTS.line1, line2: HOME_DEFAULTS.line2 }}
          limits={{ ...HOME_LIMITS }}
          maxImageLabel={`${HERO_UPLOAD.maxBytes / (1024 * 1024)} MB`}
        />
      </Card>
    </DashboardShell>
  )
}
