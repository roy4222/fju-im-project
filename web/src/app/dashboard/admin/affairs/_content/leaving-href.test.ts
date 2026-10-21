import { describe, expect, it } from 'vitest'
import { leavingHref } from '@/app/dashboard/admin/affairs/_content/leaving-href'
import { clickIntent, type AnchorLike, type ClickLike } from '@/app/_ui/nav-pending-rules'

/**
 * CL-7：「離開擋未存」與換頁骨架必須同一套判斷（CL-1 是複製一份、互相註解）。
 * 同一批點擊逐案比對：`leavingHref` 有回網址 ⇔ `clickIntent` 是 `start`。改一邊沒改另一邊就紅。
 */
const HERE = 'https://im.example.edu/dashboard/admin/affairs/rules?cohort=c1&tab=rules'

function anchor(href: string, attrs: { target?: string; download?: boolean } = {}): AnchorLike {
  return {
    href: new URL(href, HERE).href,
    target: attrs.target ?? '',
    hasAttribute: (name) => name === 'download' && Boolean(attrs.download),
  }
}

const left: ClickLike = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }

const CASES: Array<[string, AnchorLike, ClickLike]> = [
  ['站內別頁', anchor('/dashboard/admin/groups'), left],
  ['同頁換查詢字串', anchor('/dashboard/admin/affairs/rules?cohort=c2&tab=rules'), left],
  ['同頁、查詢字串順序不同', anchor('/dashboard/admin/affairs/rules?tab=rules&cohort=c1'), left],
  ['同頁、同查詢字串', anchor('/dashboard/admin/affairs/rules?cohort=c1&tab=rules'), left],
  ['只差 hash', anchor('/dashboard/admin/affairs/rules?cohort=c1&tab=rules#ch-2'), left],
  ['別頁帶 hash', anchor('/news#top'), left],
  ['空的 ?', anchor('/files?'), left],
  ['/api/ 附件下載', anchor('/api/files/abc'), left],
  ['/api 本身', anchor('/api'), left],
  ['/apix 不是 /api/', anchor('/apix'), left],
  ['外站', anchor('https://example.com/x'), left],
  ['同主機不同 port', anchor('https://im.example.edu:8443/x'), left],
  ['target=_blank', anchor('/news', { target: '_blank' }), left],
  ['target=_self', anchor('/news', { target: '_self' }), left],
  ['download', anchor('/files/1', { download: true }), left],
  ['中鍵', anchor('/news'), { ...left, button: 1 }],
  ['Cmd', anchor('/news'), { ...left, metaKey: true }],
  ['Ctrl', anchor('/news'), { ...left, ctrlKey: true }],
  ['Shift', anchor('/news'), { ...left, shiftKey: true }],
  ['Alt', anchor('/news'), { ...left, altKey: true }],
  ['相對路徑', anchor('../groups'), left],
  ['編碼不同的同一查詢', anchor('/dashboard/admin/affairs/rules?cohort=%63%31&tab=rules'), left],
]

describe('CL-7：leavingHref 與 clickIntent 同一套規則', () => {
  it.each(CASES)('%s', (_name, a, event) => {
    const leaving = leavingHref(a, { ...event, defaultPrevented: false }, HERE)
    expect(leaving !== null).toBe(clickIntent(a, event, HERE) === 'start')
  })

  it('回的是要去的網址（路徑＋查詢＋hash），別人已經擋下的點擊不再攔', () => {
    expect(leavingHref(anchor('/news?category=x#top'), { ...left, defaultPrevented: false }, HERE)).toBe('/news?category=x#top')
    expect(leavingHref(anchor('/news'), { ...left, defaultPrevented: true }, HERE)).toBeNull()
  })
})
