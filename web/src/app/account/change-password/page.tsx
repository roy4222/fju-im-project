import { redirect } from 'next/navigation'
import { currentActor } from '@/app/_ui/guard'
import { ActionForm, Field } from '@/app/_ui/form'
import { Card } from '@/app/_ui/primitives'
import { NarrowShell } from '@/app/_ui/site-shell'
import { changePasswordAction } from '@/app/account/change-password/actions'
import { MIN_PASSWORD_LENGTH } from '@/composition/accounts'

export const metadata = { title: '更改密碼｜資管系專題平台' }

/**
 * 改密碼頁。
 *
 * 這一頁**不能**要求 `business` 能力——被逼改密的人正是要來這裡的，
 * 用那個能力會把他導回自己身上變成無限迴圈。所以只確認有登入。
 */
export default async function ChangePasswordPage() {
  const actor = await currentActor()
  if (actor.kind === 'anonymous') redirect('/login?next=%2Faccount%2Fchange-password')

  const forced = actor.mustChangePassword

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
