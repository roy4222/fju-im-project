import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AuthStage } from './auth-stage'

// 規格④ §4.1：照片拿掉、只剩置中白卡（取代 auth-split.test.ts）。
describe('AuthStage 置中白卡（規格④ §4.1）', () => {
  const html = renderToStaticMarkup(createElement(AuthStage, null, '卡'))

  it('沒有 <img>、沒有左圖右卡的 lg:grid', () => {
    expect(html).not.toContain('<img')
    expect(html).not.toContain('lg:grid')
  })

  it('卡片 class 含 auth-card、最寬 440px，children 在卡片裡', () => {
    expect(html).toMatch(/<div class="auth-card [^"]*max-w-\[440px\][^"]*">卡<\/div>/)
  })

  it('外層 relative z-10：壓在固定定位的背景上面', () => {
    expect(html).toMatch(/^<div class="relative z-10 /)
  })

  it('不輸出 style 屬性（CSP）；純 Server Component', () => {
    expect(html).not.toContain('style=')
    const source = readFileSync(new URL('./auth-stage.tsx', import.meta.url), 'utf8')
    expect(source).not.toContain('use client')
  })
})
