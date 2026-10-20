import type { ReactNode } from 'react'
import { AuthGlitch } from '@/app/_ui/auth-glitch'

/** 登入頁（含忘記密碼模式）的 LetterGlitch 背景（規格④ §4.1）。 */
export default function LoginLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <AuthGlitch />
      {children}
    </>
  )
}
