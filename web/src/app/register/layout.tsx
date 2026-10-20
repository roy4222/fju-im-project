import type { ReactNode } from 'react'
import { AuthGlitch } from '@/app/_ui/auth-glitch'

/** 等待審核、申請已送出兩頁維持一般外殼（灰底卡片＋頁尾），不鋪背景（規格④ §4.1、`待問.md` Q4）。 */
const PLAIN = ['/register/pending', '/register/apply/done'] as const

/** 註冊三步的 LetterGlitch 背景：放在 layout，三步之間換頁不重掛（規格④ §4.1、AC-27）。 */
export default function RegisterLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <AuthGlitch exclude={PLAIN} />
      {children}
    </>
  )
}
