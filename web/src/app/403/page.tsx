import { currentActor, homeFor } from '@/app/_ui/guard'
import { EmptyState } from '@/app/_ui/primitives'
import { SiteShell } from '@/app/_ui/site-shell'

export const metadata = { title: '沒有權限｜資管系專題平台' }

/** 統一的 403 頁；一定要給下一步，不能只說「沒有權限」。 */
export default async function ForbiddenPage() {
  const actor = await currentActor()
  return (
    <SiteShell>
      <EmptyState
        title="這一頁不是給你的角色看的"
        description="你的帳號沒有開啟這一頁的權限。如果覺得這是錯的，請聯絡系辦。"
        action={{ href: homeFor(actor), label: '回到自己的首頁' }}
      />
    </SiteShell>
  )
}
