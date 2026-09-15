import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import './globals.css'

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
