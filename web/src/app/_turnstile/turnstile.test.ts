import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { siteKeyFromEnv, TURNSTILE_SCRIPT_SRC, TurnstileView } from './turnstile'

// 單元環境沒有 DOM，只驗伺服器畫出來的樣子；widget 真的出現、拿到 token 由 e2e 與手動證據驗。
describe('Turnstile 元件（AC-VI-66 元件段）', () => {
  const html = renderToStaticMarkup(createElement(TurnstileView, { siteKey: 'site-key', action: 'signup', nonce: 'abc123' }))

  it('api.js 走 explicit render，帶這次請求的 nonce、async 載入', () => {
    expect(TURNSTILE_SCRIPT_SRC).toBe('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit')
    const script = /<script[^>]*>/.exec(html)?.[0] ?? ''
    expect(script).toContain(`src="${TURNSTILE_SCRIPT_SRC.replace('&', '&amp;')}"`)
    expect(script).toContain('nonce="abc123"')
    expect(script).toContain('async')
  })

  it('widget 容器帶 action，不把 site key 以外的東西放進 HTML', () => {
    expect(html).toMatch(/<div[^>]*data-turnstile-action="signup"/)
    expect(html).not.toContain('secret')
  })
})

describe('siteKeyFromEnv（AC-VI-67）', () => {
  it('兩個鍵都沒設或空字串：null（不畫 widget、不載 api.js）', () => {
    expect(siteKeyFromEnv({})).toBeNull()
    expect(siteKeyFromEnv({ TURNSTILE_SITE_KEY: '', TURNSTILE_SECRET_KEY: '' })).toBeNull()
  })

  it('兩個都設：回 site key', () => {
    expect(siteKeyFromEnv({ TURNSTILE_SITE_KEY: '1x00000000000000000000AA', TURNSTILE_SECRET_KEY: 'x' })).toBe('1x00000000000000000000AA')
  })

  it('只設一個：丟錯，不帶 secret 的值', () => {
    expect(() => siteKeyFromEnv({ TURNSTILE_SITE_KEY: 'a' })).toThrow(/缺 TURNSTILE_SECRET_KEY/)
    expect(() => siteKeyFromEnv({ TURNSTILE_SECRET_KEY: 'shh' })).toThrow(/缺 TURNSTILE_SITE_KEY/)
    expect(() => siteKeyFromEnv({ TURNSTILE_SECRET_KEY: 'shh' })).not.toThrow(/shh/)
  })
})
