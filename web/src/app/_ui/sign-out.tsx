import { signOutAction } from '@/app/account/actions'

/**
 * 登出按鈕。
 *
 * 是一個真的 `<form>` 送 Server Action，不是 `<a href>`：登出會改變狀態，
 * 用 GET 連結會被瀏覽器或掃描器預先抓取而把人登出。沒有 JavaScript 也能用。
 */
export function SignOutButton({ className }: { className?: string }) {
  return (
    <form action={signOutAction}>
      <button type="submit" className={className}>
        登出
      </button>
    </form>
  )
}
