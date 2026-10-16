import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SectionHead, StatusPill, TodoCard, type Tone } from './cards'

// 單元環境沒有 DOM，只驗畫出來的 HTML；顏色與 4px 左邊框由第一張用到卡片的角色首頁票在 e2e 量（AC-SH-18）。
const TONES: readonly Tone[] = ['overdue', 'soon', 'done', 'open', 'violet', 'alert', 'neutral']
const icon = createElement('svg', { 'aria-hidden': true })

describe('TodoCard（AC-SH-17）', () => {
  const html = renderToStaticMarkup(
    createElement(TodoCard, { tone: 'overdue', icon, title: '期中報告', meta: '逾期 2 天', href: '/x', pill: { label: '逾期' } }),
  )

  it('整張是一個 <a href data-tone>，內含標題、meta 與膠囊', () => {
    expect(html.match(/<a /g)).toHaveLength(1)
    expect(html).toMatch(/^<a [^>]*href="\/x"/)
    expect(html).toMatch(/^<a [^>]*data-tone="overdue"/)
    expect(html).toContain('期中報告')
    expect(html).toContain('逾期 2 天')
    // 膠囊沒給 tone 時跟卡片同色。
    expect(html).toMatch(/<span [^>]*data-tone="overdue"[^>]*>逾期<\/span>/)
  })

  it('沒有 style 屬性（正式站 CSP）', () => {
    expect(html).not.toContain('style=')
  })

  it('七個 tone 各產生對應的 data-tone', () => {
    for (const tone of TONES) {
      const out = renderToStaticMarkup(createElement(TodoCard, { tone, icon, title: 't', href: '/x' }))
      expect(out).toMatch(new RegExp(`^<a [^>]*data-tone="${tone}"`))
      expect(out).not.toContain('style=')
    }
  })

  it('膠囊可以用自己的 tone；testId 落在 data-testid；沒給 meta、pill 就不畫', () => {
    const out = renderToStaticMarkup(
      createElement(TodoCard, { tone: 'open', icon, title: '同意書', href: '/y', pill: { tone: 'violet', label: '待簽' }, testId: 'todo-consent' }),
    )
    expect(out).toMatch(/^<a [^>]*data-testid="todo-consent"/)
    expect(out).toMatch(/<span [^>]*data-tone="violet"[^>]*>待簽<\/span>/)

    const bare = renderToStaticMarkup(createElement(TodoCard, { tone: 'neutral', icon, title: '只有標題', href: '/z' }))
    expect(bare.match(/data-tone=/g)).toHaveLength(1)
    expect(bare).not.toContain('todo-card-meta')
  })

  it('未知 tone 是型別錯誤', () => {
    // @ts-expect-error 只能用七個 tone
    const out = renderToStaticMarkup(createElement(TodoCard, { tone: 'red', icon, title: 't', href: '/x' }))
    expect(out).toContain('data-tone="red"')
    // @ts-expect-error 膠囊也一樣
    renderToStaticMarkup(createElement(StatusPill, { tone: 'green', children: 'x' }))
  })
})

describe('StatusPill（AC-SH-18）', () => {
  it('是 <span data-tone>，沒有 style', () => {
    const html = renderToStaticMarkup(createElement(StatusPill, { tone: 'done', children: '已交' }))
    expect(html).toMatch(/^<span [^>]*data-tone="done"[^>]*>已交<\/span>$/)
    expect(html).not.toContain('style=')
  })
})

describe('SectionHead（AC-SH-18）', () => {
  it('h2 標題、數字在 section-count、「查看全部」連結；沒有 style', () => {
    const html = renderToStaticMarkup(
      createElement(SectionHead, { title: '待辦', count: 3, action: { label: '查看全部', href: '/y' } }),
    )
    expect(html).toMatch(/<h2[^>]*>待辦<\/h2>/)
    expect(html).toMatch(/<[a-z]+ [^>]*data-testid="section-count"[^>]*>3<\/[a-z]+>/)
    expect(html).toMatch(/<a [^>]*href="\/y"[^>]*>查看全部/)
    expect(html).not.toContain('style=')
  })

  it('as="h3" 換標題層級；沒給 count、action 就不畫', () => {
    const html = renderToStaticMarkup(createElement(SectionHead, { title: '公告', as: 'h3' }))
    expect(html).toMatch(/<h3[^>]*>公告<\/h3>/)
    expect(html).not.toContain('<h2')
    expect(html).not.toContain('section-count')
    expect(html).not.toContain('<a ')
  })

  it('count 是 0 也要顯示', () => {
    const html = renderToStaticMarkup(createElement(SectionHead, { title: '待辦', count: 0 }))
    expect(html).toMatch(/data-testid="section-count"[^>]*>0</)
  })
})
