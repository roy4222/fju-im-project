import { describe, expect, it } from 'vitest'
import { clickIntent, navKey, shouldTrackClick, type AnchorLike, type ClickLike } from '@/app/_ui/nav-pending-rules'

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

describe('clickIntent：開始、取消、不理', () => {
  it('換到別的導覽鍵 → start（含同頁 ?page=2）', () => {
    expect(clickIntent(anchor('/dashboard/admin/groups'), left, HERE)).toBe('start')
    expect(clickIntent(anchor('/dashboard/admin/accounts?page=2'), left, HERE)).toBe('start')
  })

  it('點回目前這一頁（同鍵、含純 hash）→ cancel：慢的換頁途中點回來，舊骨架要清掉', () => {
    expect(clickIntent(anchor('/dashboard/admin/accounts?page=1'), left, HERE)).toBe('cancel')
    expect(clickIntent(anchor('#top'), left, HERE)).toBe('cancel')
  })

  it('不是這個分頁的換頁 → ignore（不能清掉進行中的骨架）', () => {
    const same = anchor('/dashboard/admin/accounts?page=1')
    expect(clickIntent(same, { ...left, metaKey: true }, HERE)).toBe('ignore')
    expect(clickIntent(anchor('/dashboard/admin/accounts?page=1', { target: '_blank' }), left, HERE)).toBe('ignore')
    expect(clickIntent(anchor('/api/files/1'), left, HERE)).toBe('ignore')
    expect(clickIntent(anchor('https://www.fju.edu.tw/'), left, HERE)).toBe('ignore')
  })
})
