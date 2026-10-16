import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AdminTabs } from './_tabs'

// 分頁列是共用元件（AC-AD-06／10／15／24 都靠它）：單元環境沒有 DOM，驗渲染出來的 HTML；各頁掛上去之後由各票的 e2e 驗。
const AFFAIRS = [
  { href: '/dashboard/admin/affairs', label: '公告與作業' },
  { href: '/dashboard/admin/showcase', label: '成果展示' },
  { href: '/dashboard/admin/files', label: '檔案' },
]

const render = (props: Parameters<typeof AdminTabs>[0]) => renderToStaticMarkup(createElement(AdminTabs, props))
const links = (html: string) => [...html.matchAll(/<a\b[^>]*>.*?<\/a>/g)].map((m) => m[0])

describe('AdminTabs', () => {
  it('渲染 nav[aria-label]，每個分頁一個連結，順序照 items', () => {
    const html = render({ label: '公告與作業分頁', current: '/dashboard/admin/showcase', items: AFFAIRS })
    expect(html).toMatch(/<nav[^>]*aria-label="公告與作業分頁"/)
    const as = links(html)
    expect(as).toHaveLength(3)
    expect(as.map((a) => a.match(/href="([^"]*)"/)?.[1])).toEqual(AFFAIRS.map((i) => i.href))
    expect(as.map((a) => a.replace(/<[^>]*>/g, ''))).toEqual(['公告與作業', '成果展示', '檔案'])
  })

  it('只有 current 那一頁標 aria-current="page"', () => {
    for (const item of AFFAIRS) {
      const as = links(render({ label: '公告與作業分頁', current: item.href, items: AFFAIRS }))
      const marked = as.filter((a) => a.includes('aria-current="page"'))
      expect(marked).toHaveLength(1)
      expect(marked[0]).toContain(`href="${item.href}"`)
    }
  })

  it('current 不在 items 裡（例如深層頁誤傳）時沒有任何一頁被標成目前頁', () => {
    const html = render({ label: '公告與作業分頁', current: '/dashboard/admin/affairs/abc', items: AFFAIRS })
    expect(html).not.toContain('aria-current')
  })

  it('actions 放在分頁列右側，不算分頁', () => {
    const html = render({
      label: '成績分頁',
      current: '/dashboard/admin/grading',
      items: [
        { href: '/dashboard/admin/grading', label: '成績管理' },
        { href: '/dashboard/admin/signoff', label: '同意書' },
      ],
      actions: createElement('a', { href: '/dashboard/admin/grading/rules' }, '評分規則 ↗'),
    })
    expect(html).toContain('評分規則 ↗')
    // 動作在 nav 外面：nav 裡只有兩個分頁連結。
    const nav = html.match(/<nav\b[\s\S]*?<\/nav>/)?.[0] ?? ''
    expect(links(nav)).toHaveLength(2)
    expect(nav).not.toContain('評分規則')
    expect(html.indexOf('評分規則')).toBeGreaterThan(html.indexOf('</nav>'))
  })

  it('沒有 actions 時不多渲染空的容器', () => {
    const html = render({ label: '分組分頁', current: '/dashboard/admin/groups', items: [{ href: '/dashboard/admin/groups', label: '分組總覽' }] })
    expect(html).toMatch(/<\/nav><\/div>$/)
  })
})
