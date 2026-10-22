import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'
import { OFFICE_COOKIE, OFFICE_REWRITE_HEADER, officeRewritePath, proxy } from '@/proxy'

/**
 * 前台編輯模式的改寫規則（C2-16；規格② 設計方案 §6.2 第 3、5 點、§9）。
 *
 * 只有「帶 `fju_office=1` 的 GET／HEAD 打五條前台路徑」才改寫；其他一律原樣（訪客的模組圖不受影響）。
 */
describe('officeRewritePath', () => {
  it('五條前台路徑＋cookie＋GET／HEAD → 改寫到對應的 /office-edit 路由', () => {
    const cases: [string, string][] = [
      ['/', '/office-edit'],
      ['/files', '/office-edit/files'],
      ['/rules', '/office-edit/rules'],
      ['/industry', '/office-edit/industry'],
      ['/privacy', '/office-edit/privacy'],
    ]
    for (const [from, to] of cases) {
      expect(officeRewritePath('GET', from, '1'), from).toBe(to)
      expect(officeRewritePath('HEAD', from, '1'), from).toBe(to)
    }
  })

  it('沒有 cookie、cookie 值不是 1 → 不改寫', () => {
    expect(officeRewritePath('GET', '/', undefined)).toBeNull()
    expect(officeRewritePath('GET', '/', '')).toBeNull()
    expect(officeRewritePath('GET', '/files', '0')).toBeNull()
  })

  it('POST（Server Action）等其他方法 → 不改寫', () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      expect(officeRewritePath(method, '/', '1'), method).toBeNull()
    }
  })

  it('五條以外的路徑（含子路徑、直接打 /office-edit、原型鏈上的鍵） → 不改寫', () => {
    for (const path of ['/news', '/files/x', '/rules/', '/office-edit', '/office-edit/files', '/dashboard/admin', '/toString', '/__proto__']) {
      expect(officeRewritePath('GET', path, '1'), path).toBeNull()
    }
  })
})

describe('proxy 套用改寫', () => {
  const request = (url: string, init: { cookie?: string; headers?: Record<string, string>; method?: string } = {}) =>
    new NextRequest(url, {
      method: init.method ?? 'GET',
      headers: { ...(init.cookie ? { cookie: init.cookie } : {}), ...init.headers },
    })

  it('系辦（有 cookie）打 / → 改寫到 /office-edit、帶請求標頭、回應 private, no-store', () => {
    const response = proxy(request('http://localhost/?x=1', { cookie: `${OFFICE_COOKIE}=1` }))
    const rewrite = response.headers.get('x-middleware-rewrite')
    expect(rewrite).not.toBeNull()
    const target = new URL(rewrite!)
    expect(target.pathname).toBe('/office-edit')
    expect(target.search).toBe('?x=1')
    expect(response.headers.get(`x-middleware-request-${OFFICE_REWRITE_HEADER}`)).toBe('1')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  })

  it('沒有 cookie → 不改寫、不加 cache-control；用戶端自己送的改寫標頭被刪掉', () => {
    const response = proxy(request('http://localhost/', { headers: { [OFFICE_REWRITE_HEADER]: '1' } }))
    expect(response.headers.get('x-middleware-rewrite')).toBeNull()
    expect(response.headers.get('cache-control')).toBeNull()
    expect(response.headers.get(`x-middleware-request-${OFFICE_REWRITE_HEADER}`)).toBeNull()
    expect(response.headers.get(OFFICE_REWRITE_HEADER)).toBeNull()
  })

  it('有 cookie 但打的是 POST → 不改寫', () => {
    const response = proxy(request('http://localhost/', { cookie: `${OFFICE_COOKIE}=1`, method: 'POST' }))
    expect(response.headers.get('x-middleware-rewrite')).toBeNull()
  })
})
