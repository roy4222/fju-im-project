import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AuthSplit } from './auth-split'

// 單元環境沒有 DOM，只看伺服器畫出的 markup；兩種寬度靠 Tailwind class 切換（AC-SH-82）。
describe('AuthSplit 左圖右卡（AC-SH-82）', () => {
  const image = { src: '/placeholder/campus.jpg', alt: '輔仁大學校園', width: 1600, height: 1067 }
  const html = renderToStaticMarkup(createElement(AuthSplit, { image }, '卡'))

  it('≥1024px 兩欄：外框切成左圖右卡', () => {
    expect(html).toContain('lg:grid-cols-[minmax(0,1fr)_560px]')
  })

  it('圖只在 ≥1024px 顯示，用原生 <img> 帶尺寸與替代文字', () => {
    const img = html.match(/<img[^>]*>/)?.[0]
    expect(img).toBeDefined()
    expect(img).toContain('src="/placeholder/campus.jpg"')
    expect(img).toContain('alt="輔仁大學校園"')
    expect(img).toContain('width="1600"')
    expect(img).toContain('height="1067"')
    // 圖被包在 hidden lg:block 裡，<1024px 不顯示
    expect(html).toMatch(/class="[^"]*\bhidden lg:block\b[^"]*"[^>]*>(?:<[^>]*>)*<img/)
  })

  it('children 永遠顯示，寬度跟 AuthCard 一樣是 440px', () => {
    expect(html).toMatch(/<div class="[^"]*max-w-\[440px\][^"]*">卡<\/div>/)
    // children 在圖那一欄（<aside>）外面，不會跟著圖一起藏起來
    expect(html.slice(html.indexOf('</aside>'))).toContain('卡')
    expect(html.slice(0, html.indexOf('</aside>'))).not.toContain('卡')
  })

  it('不疊文字標題（Roy 定案只要左圖右卡）', () => {
    expect(html).not.toContain('專題管理平台')
  })

  it('手機不白下載圖：lazy、不插 preload', () => {
    expect(html).toMatch(/<img[^>]*loading="lazy"/)
    // 手機不顯示圖，所以不能讓 React 插 preload 害手機白下載
    expect(html).not.toContain('rel="preload"')
  })

  it('純 Server Component：沒有 use client、沒有 next/image', () => {
    const source = readFileSync(new URL('./auth-split.tsx', import.meta.url), 'utf8')
    expect(source).not.toContain('use client')
    expect(source).not.toContain('next/image')
  })
})
