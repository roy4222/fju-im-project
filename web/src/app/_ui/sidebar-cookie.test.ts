import { describe, expect, it } from 'vitest'
import { sidebarOpenFromCookie } from '@/app/_ui/sidebar-cookie'

describe('側欄收合 cookie', () => {
  it('只有明確寫 false 才收合', () => {
    expect(sidebarOpenFromCookie('false')).toBe(false)
  })

  it('沒有 cookie、true 或亂填的值都展開', () => {
    expect(sidebarOpenFromCookie(undefined)).toBe(true)
    expect(sidebarOpenFromCookie('true')).toBe(true)
    expect(sidebarOpenFromCookie('nope')).toBe(true)
  })
})
