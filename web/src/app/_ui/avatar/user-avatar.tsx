import type { AvatarUser } from '@/application/accounts'
import { avatarUrl } from '@/composition/avatar-url'
import { cn } from '@/shared/cn'

/**
 * 一個人的頭像（SH-8；shared-r3 §2.0 契約）。Server Component：網址在伺服器算好，client 外框只收 `ReactNode`。
 *
 * 用原生 `<img>`，不走 next/image（它會輸出 style 屬性，被正式站 CSP 擋；同 `site-header.tsx` 的 logo）。
 * `alt` 預設是姓名；旁邊已經寫了姓名的地方（帳號選單）用 `decorative`，`alt=""` 讓報讀器不唸兩次。
 */
export function UserAvatar({
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
      className={cn('shrink-0 rounded-full bg-muted object-cover', className)}
    />
  )
}
