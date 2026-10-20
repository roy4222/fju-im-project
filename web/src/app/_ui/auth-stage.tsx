import type { ReactNode } from 'react'

/**
 * 登入、註冊、重設密碼共用的外框（規格④ §4.1，取代左圖右卡 `AuthSplit`）：只剩置中的白卡。
 * 背景（LetterGlitch）在各群組的 `layout.tsx`，固定定位壓在底下；這一層 `relative z-10` 才不會被它蓋住。
 * 白卡最寬 440 px、外圈白暈；純 Server Component。
 */
export function AuthStage({ children }: { children?: ReactNode }) {
  return (
    <div className="relative z-10 flex min-h-[calc(100dvh-5rem)] items-center justify-center px-4 py-10 sm:px-8 sm:py-16">
      <div className="auth-card w-full max-w-[440px] rounded-xl shadow-[0_0_0_1px_rgba(255,255,255,.18),0_24px_80px_rgba(255,255,255,.14)]">
        {children}
      </div>
    </div>
  )
}
