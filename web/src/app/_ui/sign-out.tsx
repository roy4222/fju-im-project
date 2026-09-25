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

/**
 * 看不見的登出表單，給帳號下拉選單裡的「登出」用（`<button form={id}>` 指到這裡）。
 *
 * 選單內容是 client 端開了才掛上去的，表單本身放在伺服器輸出的外殼裡，
 * 所以登出仍然是同一支 Server Action 的 POST，不是連結。
 */
export function SignOutForm({ id }: { id: string }) {
  return <form id={id} action={signOutAction} hidden />
}
