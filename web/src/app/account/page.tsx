import Link from 'next/link'
import { requireSignedIn } from '@/app/_ui/guard'
import { SignOutButton } from '@/app/_ui/sign-out'
import { Card, EmptyState } from '@/app/_ui/primitives'
import { SiteShell } from '@/app/_ui/site-shell'

export const metadata = { title: '我的帳號｜資管系專題平台' }

/**
 * 本人帳號頁的殼。要 `business` 能力：待審核與被要求改密的人
 * 會先被導去各自的頁面（待審核頁、改密頁）。
 */
export default async function AccountPage() {
  await requireSignedIn('/account', 'business')

  return (
    <SiteShell>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-ink">我的帳號</h1>
        <div className="flex items-center gap-2">
          <Link
            href="/account/change-password"
            className="rounded-md bg-muted px-3 py-1.5 text-sm text-foreground hover:bg-border"
          >
            更改密碼
          </Link>
          <SignOutButton className="rounded-md px-3 py-1.5 text-sm text-ink hover:bg-muted" />
        </div>
      </div>
      <div className="mt-6 grid gap-4">
        <Card title="基本資料" description="姓名、學號、系級與屆別由系辦維護；手機與聯絡 Email 本人可改。">
          <EmptyState pending title="資料欄位還沒做" description="手機與聯絡 Email 的修改功能還在做，需要更正請先找系辦。" />
        </Card>
        <Card title="登入方式" description="可以同時有密碼與 Google 兩種登入方式。">
          <EmptyState pending title="連結與設密碼還沒做" description="連結 Google 與設定密碼的功能還在做。" />
        </Card>
      </div>
    </SiteShell>
  )
}
