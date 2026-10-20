import type { ReactNode } from 'react'
import { AuthGlitch } from '@/app/_ui/auth-glitch'

/** 重設密碼頁的 LetterGlitch 背景（規格④ §4.1）。 */
export default function ResetPasswordLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <AuthGlitch />
      {children}
    </>
  )
}
