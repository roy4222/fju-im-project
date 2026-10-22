import type { ComponentProps } from 'react'
import { AvatarImg } from '@/app/_ui/avatar/avatar-img'

/**
 * 一個人的頭像（SH-8；shared-r3 §2.0 契約）。Server Component 照舊用這個，props 不變（`user`、`size`、`decorative?`）。
 *
 * 輸出交給 `AvatarImg`（C3-02）：`<img>` 的屬性與共用樣式只有一份，伺服器頁面與 client 元件畫出來一樣，不會各改各的。
 * 用原生 `<img>`，不走 next/image（它會輸出 style 屬性，被正式站 CSP 擋；同 `site-header.tsx` 的 logo）。
 */
export function UserAvatar(props: ComponentProps<typeof AvatarImg>) {
  return <AvatarImg {...props} />
}
