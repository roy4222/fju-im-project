import { describe, expect, it } from 'vitest'
import { isSameOriginRequest } from '@/shared/same-origin'

describe('isSameOriginRequest', () => {
  it('瀏覽器帶 Sec-Fetch-Site: same-origin 才放行', () => {
    expect(isSameOriginRequest(new Headers({ 'sec-fetch-site': 'same-origin' }))).toBe(true)
    expect(isSameOriginRequest(new Headers({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }))).toBe(false)
    expect(isSameOriginRequest(new Headers({ 'sec-fetch-site': 'same-site' }))).toBe(false)
  })

  it('沒有 Sec-Fetch-Site 時看 Origin 的主機是否等於 Host', () => {
    expect(isSameOriginRequest(new Headers({ origin: 'http://127.0.0.1:3000', host: '127.0.0.1:3000' }))).toBe(true)
    expect(isSameOriginRequest(new Headers({ origin: 'https://evil.example', host: 'fju.example' }))).toBe(false)
  })

  it('或等於設定的站台網址', () => {
    const headers = new Headers({ origin: 'https://fju.roy422.dev', host: 'app:3000' })
    expect(isSameOriginRequest(headers, ['https://fju.roy422.dev'])).toBe(true)
    expect(isSameOriginRequest(headers, ['https://other.example'])).toBe(false)
  })

  it('兩個標頭都沒有（例如 curl）或 Origin 是 null：拒絕', () => {
    expect(isSameOriginRequest(new Headers({ host: 'fju.example' }))).toBe(false)
    expect(isSameOriginRequest(new Headers({ origin: 'null', host: 'fju.example' }))).toBe(false)
  })
})
