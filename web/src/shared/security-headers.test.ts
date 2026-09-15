import { describe, expect, it } from 'vitest'
import {
  buildContentSecurityPolicy,
  createNonce,
  cspDirectives,
  staticSecurityHeaders,
} from '@/shared/security-headers'

const nonce = 'TESTNONCE1234567890=='

function directive(csp: string, name: string): string {
  const found = csp.split('; ').find((part) => part.startsWith(`${name} `))
  if (!found) throw new Error(`CSP 裡沒有 ${name}：${csp}`)
  return found.slice(name.length + 1)
}

describe('CSP 指令與契約 03 §6 一致（T2 方案 A）', () => {
  const csp = buildContentSecurityPolicy({ nonce })

  it('script-src 是 self＋nonce＋strict-dynamic', () => {
    expect(directive(csp, 'script-src')).toBe(`'self' 'nonce-${nonce}' 'strict-dynamic'`)
  })

  it('style-src 是 self＋nonce', () => {
    expect(directive(csp, 'style-src')).toBe(`'self' 'nonce-${nonce}'`)
  })

  it('其餘指令逐字對照契約', () => {
    expect(directive(csp, 'default-src')).toBe("'self'")
    expect(directive(csp, 'img-src')).toBe("'self' blob: data: https://i.ytimg.com")
    expect(directive(csp, 'frame-src')).toBe('https://www.youtube.com https://challenges.cloudflare.com')
    expect(directive(csp, 'object-src')).toBe("'none'")
    expect(directive(csp, 'base-uri')).toBe("'self'")
    expect(directive(csp, 'form-action')).toBe("'self'")
    expect(directive(csp, 'frame-ancestors')).toBe("'none'")
  })

  it('production 不放 unsafe-inline 或 unsafe-eval', () => {
    expect(csp).not.toContain('unsafe-inline')
    expect(csp).not.toContain('unsafe-eval')
  })

  it('開發模式才加 unsafe-eval 與 unsafe-inline（React 的 eval 與 HMR 樣式）', () => {
    const dev = buildContentSecurityPolicy({ nonce, development: true })
    expect(directive(dev, 'script-src')).toContain("'unsafe-eval'")
    expect(directive(dev, 'style-src')).toContain("'unsafe-inline'")
  })

  it('指令沒有重複，格式是「名稱 值」以 ; 分隔', () => {
    const names = cspDirectives({ nonce }).map(([name]) => name)
    expect(new Set(names).size).toBe(names.length)
    for (const part of buildContentSecurityPolicy({ nonce }).split('; ')) {
      expect(part).toMatch(/^[a-z-]+ .+$/)
    }
  })
})

describe('nonce', () => {
  it('每次都不一樣，而且夠長', () => {
    const values = new Set(Array.from({ length: 50 }, () => createNonce()))
    expect(values.size).toBe(50)
    for (const value of values) {
      expect(value.length).toBeGreaterThanOrEqual(16)
    }
  })

  it('是 base64，可以直接放進 CSP 而不用再逃逸', () => {
    expect(createNonce()).toMatch(/^[A-Za-z0-9+/]+=*$/)
  })
})

describe('其他安全標頭', () => {
  it('http 不送 HSTS，https 才送', () => {
    const names = (opts?: { https?: boolean }) => staticSecurityHeaders(opts).map(([n]) => n)
    expect(names()).not.toContain('strict-transport-security')
    expect(names({ https: true })).toContain('strict-transport-security')
  })

  it('nosniff、referrer-policy、frame-options、permissions-policy 都在', () => {
    const headers = Object.fromEntries(staticSecurityHeaders())
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
    expect(headers['x-frame-options']).toBe('DENY')
    expect(headers['permissions-policy']).toContain('camera=()')
  })
})
