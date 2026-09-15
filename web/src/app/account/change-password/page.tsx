import { currentActor } from '@/app/_ui/guard'
import { Card, EmptyState } from '@/app/_ui/primitives'
import { NarrowShell } from '@/app/_ui/site-shell'
import { redirect } from 'next/navigation'

export const metadata = { title: '更改密碼｜資管系專題平台' }

/**
 * 強制改密頁。
 *
 * 這一頁**不能**用 `requireSignedIn('...', 'business')`——被要求改密的人正是要來這裡的，
 * 用那個能力會把他導回自己身上變成無限迴圈。所以這裡只確認有登入。
 * 表單與撤其他 session 由 S01-05。
 */
export default async function ChangePasswordPage() {
  const actor = await currentActor()
  if (actor.kind === 'anonymous') redirect('/login?next=%2Faccount%2Fchange-password')

  return (
    <NarrowShell>
      <Card
        title="請先更改密碼"
        description={
          actor.mustChangePassword
            ? '你目前用的是一次性密碼。設定新密碼之後才能使用其他功能。'
            : '你可以在這裡更改密碼。'
        }
      >
        <EmptyState
          pending
          title="改密表單還沒做"
          description="新密碼表單、改密後撤銷其他裝置的登入，由 S01-05 掛上來。"
        />
      </Card>
    </NarrowShell>
  )
}
