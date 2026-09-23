import Link from 'next/link'
import { Card, EmptyState } from '@/app/_ui/primitives'
import { NarrowShell } from '@/app/_ui/site-shell'

export const metadata = { title: '登入｜資管系專題平台' }

/**
 * 登入頁的**殼**。真正的表單（Google 按鈕、Email 密碼、限速、Turnstile）由 S01-05／
 * S01-14／S01-15 掛上來——本票刻意不放表單，免得畫面看起來能用其實不能。
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const { next } = await searchParams

  return (
    <NarrowShell>
      <Card title="登入" description="用系上的 Email 與密碼登入；Google 登入之後會開放。">
        {next ? (
          <p className="mb-4 rounded-md bg-primary-subtle px-3 py-2 text-sm text-primary-on-subtle">
            登入後會回到你原本要去的頁面。
          </p>
        ) : null}
        <EmptyState
          pending
          title="登入表單還沒做"
          description="這一頁目前只有版面。Email 與密碼登入由 S01-05 掛上來，Google 登入由 S01-14。"
          action={{ href: '/', label: '回首頁' }}
        />
      </Card>
      <p className="mt-4 text-center text-sm text-muted-foreground">
        還沒有帳號？<Link className="underline" href="/register">註冊</Link>
      </p>
    </NarrowShell>
  )
}
