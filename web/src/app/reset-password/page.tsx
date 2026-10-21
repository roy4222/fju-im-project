import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { AuthStage } from '@/app/_ui/auth-stage'
import { SiteShell } from '@/app/_ui/site-shell'
import { ResetForm } from '@/app/reset-password/reset-form'
import { MIN_PASSWORD_LENGTH } from '@/composition/accounts'

export const metadata: Metadata = {
  title: '重設密碼｜資管系專題平台',
  robots: { index: false },
  // 網址帶著重設 token：點頁面上的連結時不能把它當 referrer 送出去。
  referrer: 'no-referrer',
}

/**
 * 重設密碼（visitor-r3 設計方案 §3.4；信裡的連結 `/reset-password?token=…`）。不用登入就能開。
 *
 * 沒有 token 直接導回忘記密碼模式。token 有沒有效要送出時才知道（套件只在重設時一次驗證並作廢）；
 * 失效或過期都顯示同一句「這個連結已失效，請重新申請」。成功後這個人的所有 session 會被撤掉（VB-2）。
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>
}) {
  const { token } = await searchParams
  if (typeof token !== 'string' || !token.trim()) redirect('/login?mode=forgot')

  return (
    <SiteShell bare footer={false}>
      <AuthStage>
        <ResetForm token={token} minLength={MIN_PASSWORD_LENGTH} />
      </AuthStage>
    </SiteShell>
  )
}
