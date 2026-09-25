import Link from 'next/link'
import type { Metadata } from 'next'
import { AuthCard } from '@/app/_ui/primitives'
import { NarrowShell } from '@/app/_ui/site-shell'

export const metadata: Metadata = {
  title: '忘記密碼｜資管系專題平台',
  robots: { index: false },
  alternates: { canonical: '/forgot-password' },
}

/**
 * 忘記密碼（原型 `/forgot-password` 的卡片版型；內容照產品模組 01）。
 *
 * 正式版**不寄信**（Email 寄送延後）：模組 01「原型與規格的差異」——這一頁改為說明找系辦；
 * 系辦在帳號管理按「重設臨時密碼」，一次性密碼只在系辦畫面顯示一次，本人登入後必須改密碼。
 * 所以這裡沒有表單、不收 Email，也不會假稱「已寄出」（模組 01 §4：不可在介面假稱已寄信）。
 */
export default function ForgotPasswordPage() {
  return (
    <NarrowShell>
      <AuthCard title="忘記密碼" description="本站目前不寄重設信。依你的登入方式處理：">
        <div className="flex flex-col gap-4" data-testid="forgot-password">
          <section className="rounded-[10px] bg-secondary p-4.5 text-secondary-foreground">
            <h2 className="font-bold text-foreground">用 Google 帳號登入的</h2>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              Google 登入的帳號在本站沒有密碼。回登入頁按「使用 Google 帳號登入」即可；Google 密碼請到 Google 帳戶重設。
            </p>
          </section>
          <section className="rounded-[10px] bg-secondary p-4.5 text-secondary-foreground">
            <h2 className="font-bold text-foreground">用 Email 與密碼登入的</h2>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              請聯絡系辦公室（電話 +886-2-2905-2696）。系辦核對你的身分後會發一組臨時密碼，只顯示一次；
              用它登入後，系統會要求你立刻設定新密碼。
            </p>
          </section>
          <Link href="/login" className="btn-fju h-12 text-base">
            回登入頁
          </Link>
        </div>
      </AuthCard>
    </NarrowShell>
  )
}
