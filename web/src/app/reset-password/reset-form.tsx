'use client'
import Link from 'next/link'
import { useActionState } from 'react'
import { Field, HiddenField } from '@/app/_ui/form'
import { AuthCard } from '@/app/_ui/primitives'
import { resetPasswordAction } from './actions'
import type { ResetState } from './reset-state'

/** 重設密碼表單：新密碼＋確認密碼；成功、連結失效各換成一段說明。 */
export function ResetForm({ token, minLength }: { token: string; minLength: number }) {
  const [state, action, pending] = useActionState<ResetState, FormData>(resetPasswordAction, undefined)

  if (state?.status === 'done') {
    return (
      <AuthCard title="密碼已重設，請用新密碼登入">
        <Link href="/login" className="btn-fju h-12 w-full text-base">
          前往登入
        </Link>
      </AuthCard>
    )
  }

  if (state?.status === 'expired') {
    return (
      <AuthCard title="這個連結已失效，請重新申請" description="重設連結 30 分鐘內有效，而且只能用一次。">
        <Link href="/login?mode=forgot" className="btn-fju h-12 w-full text-base">
          重新申請重設連結
        </Link>
      </AuthCard>
    )
  }

  const error = state?.status === 'error' ? state : null
  return (
    <AuthCard title="重設密碼" description="設定新的密碼，之後用它登入。">
      <form key={error?.attempt ?? 0} action={action} className="flex flex-col gap-4.5">
        <Field
          label="新密碼"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          hint={`至少 ${minLength} 個字元。`}
        />
        <Field label="確認密碼" name="confirmPassword" type="password" autoComplete="new-password" />
        <HiddenField name="token" value={token} />
        {error ? (
          <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
            {error.error}
          </p>
        ) : null}
        <button type="submit" disabled={pending} className="btn-fju h-12 w-full text-base">
          {pending ? '處理中…' : '重設密碼'}
        </button>
      </form>
    </AuthCard>
  )
}
