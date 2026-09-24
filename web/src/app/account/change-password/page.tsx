import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { requireSignedIn } from '@/app/_ui/guard'
import { ActionForm, Field } from '@/app/_ui/form'
import { Card } from '@/app/_ui/primitives'
import { NarrowShell } from '@/app/_ui/site-shell'
import { changePasswordAction } from '@/app/account/change-password/actions'
import { getSelfAccountCommand, MIN_PASSWORD_LENGTH } from '@/composition/accounts'

export const metadata = { title: '更改密碼｜資管系專題平台' }

/**
 * 改密碼頁。
 *
 * 這一頁**不能**要求 `business` 能力——被逼改密的人正是要來這裡的，
 * 用那個能力會把他導回自己身上變成無限迴圈。所以用 `self.changePassword` 的狀態閘門：
 * pending 與 must-change 都放行，未登入、停用、去識別化導去登入。
 */
export default async function ChangePasswordPage() {
  const actor = await requireSignedIn('/account/change-password', 'self.changePassword')

  const forced = actor.mustChangePassword
  // 只有 Google 的帳號沒有「目前的密碼」可填；請他到帳號頁「設定密碼」（票 10）。
  if (!forced) {
    const me = await getSelfAccountCommand().viewMine(await headers())
    if (me && !me.loginMethods.password) redirect('/account')
  }

  return (
    <NarrowShell>
      <Card
        title={forced ? '請先更改密碼' : '更改密碼'}
        description={
          forced
            ? '你現在用的是一次性密碼。設定新密碼之後才能使用其他功能。'
            : '改完之後，你在其他裝置的登入都會失效。'
        }
      >
        <ActionForm action={changePasswordAction} submitLabel="設定新密碼">
          <Field
            label={forced ? '目前的一次性密碼' : '目前的密碼'}
            name="currentPassword"
            type="password"
            autoComplete="current-password"
          />
          <Field
            label="新密碼"
            name="newPassword"
            type="password"
            autoComplete="new-password"
            hint={`至少 ${MIN_PASSWORD_LENGTH} 個字元，而且不能跟目前的密碼一樣。`}
          />
          <Field label="再輸入一次新密碼" name="confirmPassword" type="password" autoComplete="new-password" />
        </ActionForm>
      </Card>
      <p className="mt-4 text-center text-xs text-muted-foreground">
        改完密碼之後，這個帳號在其他瀏覽器或裝置上的登入都會被撤銷。
      </p>
    </NarrowShell>
  )
}
