'use client'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useActionState, useEffect, useRef, useState, type ReactNode } from 'react'
import { trackEvent } from '@/app/_analytics/track'
import { ActionForm, Field, HiddenField } from '@/app/_ui/form'
import { AuthCard } from '@/app/_ui/primitives'
import { requestPasswordResetAction, signInAction } from './actions'
import type { ForgotState } from './forgot-state'

export type LoginMode = 'login' | 'forgot'

/**
 * 登入卡三種模式（visitor-r3 設計方案 §3.4；原型 `login-card.tsx`）：登入、忘記密碼、已寄出。
 *
 * - 畫面由網址的 `?mode=` 決定：卡內切換用 `replaceState` 改網址（不多一筆歷史、不整頁跳轉），
 *   從頂部或頁尾的「登入」連結回到 `/login` 也一樣回登入模式；忘記密碼面板卸掉，已寄出與錯誤狀態跟著清掉。
 * - 「忘記密碼？」仍是 `<a href="/forgot-password">`：沒有 JavaScript 時照連結走，伺服器再導回 `?mode=forgot`。
 * - 兩種表單之間 Email 互相帶過去（「返回登入」時登入欄已經填好）。
 * - 只畫目前這個模式的表單：畫面上永遠只有一個 Email 欄。
 *
 * Google 鈕、Turnstile、註冊提示句是伺服器畫好的節點，由頁面傳進來。
 */
export function LoginCard({
  next,
  notice,
  google,
  turnstile,
  registerHint,
}: {
  next: string | null
  notice?: ReactNode
  google: ReactNode
  turnstile?: ReactNode
  registerHint?: ReactNode
}) {
  const mode: LoginMode = useSearchParams().get('mode') === 'forgot' ? 'forgot' : 'login'
  const [email, setEmail] = useState('')
  // 換模式時重掛表單，讓 Email 欄吃到新的預設值。
  const [round, setRound] = useState(0)
  const card = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (mode === 'forgot') trackEvent('forgot_password')
  }, [mode])

  const switchTo = (target: LoginMode, carried?: string) => {
    const typed = carried ?? card.current?.querySelector<HTMLInputElement>('input[name="email"]')?.value ?? ''
    setEmail(typed.trim())
    setRound((r) => r + 1)
    const url = new URL(window.location.href)
    if (target === 'forgot') url.searchParams.set('mode', 'forgot')
    else url.searchParams.delete('mode')
    window.history.replaceState(null, '', `${url.pathname}${url.search}`)
  }
  const loginHref = next ? `/login?next=${encodeURIComponent(next)}` : '/login'

  if (mode === 'forgot') {
    return (
      <div ref={card}>
        {/* 每次進來都重掛：上一輪的「已寄出」或錯誤不會殘留。 */}
        <ForgotPanel
          key={round}
          email={email}
          turnstile={turnstile}
          loginHref={loginHref}
          onBack={(carried) => switchTo('login', carried)}
        />
      </div>
    )
  }

  return (
    <div ref={card} data-testid="login-card" data-mode="login">
      <AuthCard title="登入" description="學生、老師與系辦使用同一個入口。">
        {notice}
        {google}

        <div className="my-5 flex items-center gap-3 text-[13px] text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          或使用 Email 與密碼
          <span className="h-px flex-1 bg-border" />
        </div>

        <ActionForm key={`login-${round}`} action={signInAction} submitLabel="登入">
          <Field label="Email" name="email" type="email" autoComplete="username" defaultValue={email} />
          <Field
            label="密碼"
            name="password"
            type="password"
            autoComplete="current-password"
            trailing={
              // 有 JavaScript 時攔下來切模式；沒有時照 href 走，`/forgot-password` 再導回 `?mode=forgot`。
              // 問號不算進無障礙名稱：連結的名字維持「忘記密碼」（既有 e2e 以這個名字找它）。
              <Link
                href="/forgot-password"
                prefetch={false}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
                  event.preventDefault()
                  switchTo('forgot')
                }}
                // 14 px；觸控裝置高度 44 px，負邊距是透明延伸區、不撐開標籤列（規格④ §4.4）。
                className="text-sm font-semibold text-primary hover:underline pointer-coarse:-my-3 pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
              >
                忘記密碼<span aria-hidden="true">？</span>
              </Link>
            }
          />
          {next ? <HiddenField name="next" value={next} /> : null}
        </ActionForm>
        {registerHint}
      </AuthCard>
    </div>
  )
}

/** 忘記密碼與已寄出兩個模式；送出的狀態只活在這一輪。 */
function ForgotPanel({
  email,
  turnstile,
  loginHref,
  onBack,
}: {
  email: string
  turnstile?: ReactNode
  loginHref: string
  onBack: (carried?: string) => void
}) {
  const [state, action, pending] = useActionState<ForgotState, FormData>(requestPasswordResetAction, undefined)

  if (state?.status === 'sent') {
    return (
      <div data-testid="login-card" data-mode="sent">
        <AuthCard title="已寄出，請到信箱收信">
          <p className="text-sm leading-relaxed text-muted-foreground" data-testid="reset-sent">
            重設連結已寄到 <span className="font-semibold text-foreground">{state.email}</span>
            ，連結 30 分鐘內有效。沒看到的話，找找垃圾郵件匣。
          </p>
          <BackToLogin href={loginHref} onBack={() => onBack(state.email)} />
        </AuthCard>
      </div>
    )
  }

  const error = state?.status === 'error' ? state : null
  return (
    <div data-testid="login-card" data-mode="forgot">
      <AuthCard title="忘記密碼" description="輸入 Email，我們寄重設連結給你。">
        <form key={error?.attempt ?? 0} action={action} className="flex flex-col gap-4.5">
          <Field
            label="Email"
            name="email"
            type="email"
            autoComplete="username"
            defaultValue={error?.values.email ?? email}
          />
          {turnstile}
          {error ? (
            <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
              {error.error}
            </p>
          ) : null}
          <button type="submit" disabled={pending} className="btn-fju h-12 w-full text-base">
            {pending ? '處理中…' : '寄重設連結'}
          </button>
        </form>
        <BackToLogin href={loginHref} onBack={() => onBack()} />
      </AuthCard>
    </div>
  )
}

/** 「返回登入」：有 JavaScript 時切回登入模式（Email 帶過去）；沒有時就是回 `/login` 的連結。 */
function BackToLogin({ href, onBack }: { href: string; onBack: () => void }) {
  return (
    <Link
      href={href}
      prefetch={false}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
        event.preventDefault()
        onBack()
      }}
      className="mt-4 block text-center text-sm font-semibold text-primary hover:underline"
    >
      返回登入
    </Link>
  )
}
