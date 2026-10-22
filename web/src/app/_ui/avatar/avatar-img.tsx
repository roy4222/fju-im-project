'use client'
import type { AvatarUser } from '@/application/accounts'
// 頭像網址是 application 層的純函式（沒有資料庫、沒有 Next），client 元件直接用（C3 設計方案 §2.2 選 (b)）；
// composition 的 `avatar-url.ts` 是 server-only，client 拿不到。
// eslint-disable-next-line fju/module-boundary
import { avatarUrl } from '@/application/accounts/avatar'
import { cn } from '@/shared/cn'

/** 頭像 `<img>` 的共用樣式；`UserAvatar` 也經這個元件輸出，伺服器與 client 畫出來一模一樣。 */
const AVATAR_IMG_CLASS = 'shrink-0 rounded-full bg-muted object-cover'

/**
 * 一個人的頭像（client 也能 render；C3 §2.2）。props 同 `UserAvatar`。
 *
 * 用原生 `<img>`，不走 next/image（它會輸出 style 屬性，被正式站 CSP 擋）。照片網址是既有的 `/api/files/<id>`
 * （每次下載重新授權），預設圖是 `/avatars/NNN.webp`；沒有另開公開路徑（AC-C3-46）。
 * `alt` 預設是姓名；旁邊已經寫了姓名的地方用 `decorative`，`alt=""` 讓報讀器不唸兩次。
 */
export function AvatarImg({
  user,
  size,
  decorative = false,
  className,
}: {
  user: AvatarUser
  size: 24 | 32 | 40 | 64 | 128
  decorative?: boolean
  className?: string
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={avatarUrl(user)}
      alt={decorative ? '' : user.name}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      className={cn(AVATAR_IMG_CLASS, className)}
    />
  )
}
