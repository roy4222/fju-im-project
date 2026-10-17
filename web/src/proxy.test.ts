import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'
import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'
import { config, proxy } from '@/proxy'

const ID = '01890000-0000-7000-8000-000000000001'
const matches = (url: string) => unstable_doesMiddlewareMatch({ config, url })

describe('proxy 的 matcher（A-06：只有檔案預覽自管標頭）', () => {
  it('檔案預覽不經過 proxy：不會被蓋成全站的 frame-ancestors none／DENY', () => {
    expect(matches(`/api/files/${ID}/preview`)).toBe(false)
    expect(matches(`/api/files/${ID}/preview?x=1`)).toBe(false)
  })

  it('其他路徑照舊經過 proxy：頁面、下載路由、看起來像預覽但不是的路徑', () => {
    for (const url of [
      '/',
      '/dashboard/teacher/grading',
      `/api/files/${ID}`,
      `/api/files/${ID}/preview/x`,
      `/api/files/${ID}/previewx`,
      '/api/files/preview',
      `/dashboard/api/files/${ID}/preview`,
    ]) {
      expect(matches(url), url).toBe(true)
    }
  })

  it('經過 proxy 的回應仍是 frame-ancestors none＋DENY，frame-src 只多同站', () => {
    const response = proxy(new NextRequest('http://localhost/dashboard/teacher/grading'))
    const csp = response.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("frame-src 'self' https://www.youtube.com https://challenges.cloudflare.com;")
    expect(response.headers.get('x-frame-options')).toBe('DENY')
  })
})
