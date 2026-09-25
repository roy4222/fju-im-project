'use client'
import { useActionState } from 'react'
import { googleSignInAction } from './actions'

/**
 * 「使用 Google 帳號登入／註冊」大按鈕（票 10；原型 `/login`、`/register`）。
 *
 * 是一個真的 `<form>` 送 Server Action：伺服器向套件要 Google 授權網址（state＋PKCE 由套件產生，
 * state cookie 由 `nextCookies()` 帶進回應），再 `redirect()` 過去。沒有 JavaScript 也能用。
 * 登入頁與註冊頁共用；`from` 決定失敗時回哪一頁顯示錯誤。
 */
export function GoogleButton({
  from,
  next,
  label,
}: {
  from: 'login' | 'register'
  next?: string | null
  label: string
}) {
  const [state, formAction, pending] = useActionState(googleSignInAction, undefined)
  return (
    <form action={formAction}>
      <input type="hidden" name="from" value={from} />
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-12 w-full items-center justify-center gap-2.5 rounded-md border border-border bg-background text-[15px] font-bold text-foreground transition-colors hover:bg-accent disabled:opacity-60"
      >
        <GoogleIcon />
        {pending ? '前往 Google…' : label}
      </button>
      {state?.error ? (
        <p role="alert" className="mt-2 rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
          {state.error}
        </p>
      ) : null}
    </form>
  )
}

/** Google 的「G」標誌（官方四色；品牌規範要求按鈕上用原色）。 */
function GoogleIcon() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 48 48">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  )
}
