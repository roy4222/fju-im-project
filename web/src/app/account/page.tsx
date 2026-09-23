import { requireSignedIn } from '@/app/_ui/guard'
import { Card, EmptyState } from '@/app/_ui/primitives'
import { SiteShell } from '@/app/_ui/site-shell'

export const metadata = { title: '我的帳號｜資管系專題平台' }

/**
 * 本人帳號頁的殼。任何登入者都看得到（包含待審核與被要求改密的人——
 * 他們會先被導走，這裡的 capability 用 `self.session`）。
 */
export default async function AccountPage() {
  await requireSignedIn('/account', 'self.session')

  return (
    <SiteShell>
      <h1 className="text-xl font-semibold text-ink">我的帳號</h1>
      <div className="mt-6 grid gap-4">
        <Card title="基本資料" description="姓名、學號、系級與屆別由系辦維護；手機與聯絡 Email 本人可改。">
          <EmptyState pending title="資料欄位還沒做" description="本人可改的欄位由 S01-13 掛上來。" />
        </Card>
        <Card title="登入方式" description="可以同時有密碼與 Google 兩種登入方式。">
          <EmptyState pending title="連結與設密碼還沒做" description="連結 Google 由 S01-14，設定密碼由 S01-14。" />
        </Card>
      </div>
    </SiteShell>
  )
}
