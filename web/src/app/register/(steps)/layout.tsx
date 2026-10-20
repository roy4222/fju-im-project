import type { ReactNode } from 'react'
import { AuthGlitch } from '@/app/_ui/auth-glitch'

/**
 * 註冊三步（`/register`、`/register/verify`、`/register/apply`）的 LetterGlitch 背景：放在 route group 的 layout，
 * 三步之間換頁不重掛（規格④ §4.1、AC-27）。等待審核、申請已送出兩頁留在 group 外面（`待問.md` Q4），
 * 連背景外殼的 chunk 都不下載。
 */
export default function RegisterLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <AuthGlitch />
      {children}
    </>
  )
}
