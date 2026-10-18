import { describe, expect, it } from 'vitest'
import { navKey, shouldTrackClick, type AnchorLike, type ClickLike } from '@/app/_ui/nav-pending-rules'

const HERE = 'https://im.example.edu/dashboard/admin/accounts?page=1'

function anchor(href: string, attrs: { target?: string; download?: boolean } = {}): AnchorLike {
  const url = new URL(href, HERE)
  return {
    href: url.href,
    target: attrs.target ?? '',
    hasAttribute: (name) => name === 'download' && Boolean(attrs.download),
  }
}

const left: ClickLike = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }

describe('navKey：pathname + search（不含 hash）', () => {
  it('只取路徑與查詢字串', () => {
    expect(navKey('https://im.example.edu/dashboard/student/affairs?tab=done#top')).toBe('/dashboard/student/affairs?tab=done')
    expect(navKey('https://im.example.edu/')).toBe('/')
  })

  it('空的 ? 跟沒有一樣', () => {
    expect(navKey('https://im.example.edu/files?')).toBe(navKey('https://im.example.edu/files'))
  })
})

describe('shouldTrackClick：哪些點擊要追蹤換頁骨架', () => {
  it('同源、換到別頁：追蹤', () => {
    expect(shouldTrackClick(anchor('/dashboard/admin/groups'), left, HERE)).toBe(true)
  })

  it('同頁只換 ?page=2 也算換頁（AC-66）', () => {
    expect(shouldTrackClick(anchor('/dashboard/admin/accounts?page=2'), left, HERE)).toBe(true)
  })

  it('純 hash 變更不追蹤（AC-48）', () => {
    expect(shouldTrackClick(anchor('/dashboard/admin/accounts?page=1#list'), left, HERE)).toBe(false)
    expect(shouldTrackClick(anchor('#top'), left, HERE)).toBe(false)
  })

  it('導覽鍵相同（點自己這頁）不追蹤', () => {
    expect(shouldTrackClick(anchor('/dashboard/admin/accounts?page=1'), left, HERE)).toBe(false)
  })

  it('外站不追蹤', () => {
    expect(shouldTrackClick(anchor('https://www.fju.edu.tw/'), left, HERE)).toBe(false)
    expect(shouldTrackClick(anchor('http://im.example.edu/dashboard/admin/groups'), left, HERE)).toBe(false)
  })

  it('修飾鍵、非左鍵不追蹤（AC-48）', () => {
    const target = anchor('/dashboard/admin/groups')
    expect(shouldTrackClick(target, { ...left, metaKey: true }, HERE)).toBe(false)
    expect(shouldTrackClick(target, { ...left, ctrlKey: true }, HERE)).toBe(false)
    expect(shouldTrackClick(target, { ...left, shiftKey: true }, HERE)).toBe(false)
    expect(shouldTrackClick(target, { ...left, altKey: true }, HERE)).toBe(false)
    expect(shouldTrackClick(target, { ...left, button: 1 }, HERE)).toBe(false)
  })

  it('有 target（_blank 等）或 download 不追蹤（AC-48）', () => {
    expect(shouldTrackClick(anchor('/dashboard/admin/groups', { target: '_blank' }), left, HERE)).toBe(false)
    expect(shouldTrackClick(anchor('/api/files/1', { download: true }), left, HERE)).toBe(false)
  })

  it('target="_self" 視同沒有', () => {
    expect(shouldTrackClick(anchor('/dashboard/admin/groups', { target: '_self' }), left, HERE)).toBe(true)
  })

  it('/api/ 底下（檔案下載）不是換頁，不追蹤', () => {
    expect(shouldTrackClick(anchor('/api/files/0190f0e2'), left, HERE)).toBe(false)
  })

  it('mailto:、tel: 不追蹤', () => {
    expect(shouldTrackClick(anchor('mailto:im@example.edu'), left, HERE)).toBe(false)
    expect(shouldTrackClick(anchor('tel:0229052000'), left, HERE)).toBe(false)
  })
})
