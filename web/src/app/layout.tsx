import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import './globals.css'

// T2 方案 A：全站動態渲染，nonce 才能每個回應都不一樣（契約 03 §6、契約 02 §9）。
// 快取只用在資料函式的 'use cache'，不在頁面層（契約 02 §8）。
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: '輔仁大學資訊管理學系專題管理平台',
  description: '專題管理平台（開發中）',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-Hant-TW">
      <body>{children}</body>
    </html>
  )
}
