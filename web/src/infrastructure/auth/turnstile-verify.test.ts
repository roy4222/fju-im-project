import { describe, expect, it, vi } from 'vitest'
import {
  readTurnstileConfig,
  SITEVERIFY_URL,
  turnstileSiteKey,
  verifyTurnstile,
  type TurnstileConfig,
} from '@/infrastructure/auth/turnstile-verify'

/** VB-7：siteverify 模組（契約 03 §7；AC-VI-66 模組段、AC-VI-67）。 */

const REAL: TurnstileConfig = { enabled: true, siteKey: 'site-real', secretKey: 'secret-real' }
const HOST = 'test.fju.roy422.dev'

function reply(body: unknown, status = 200) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }))
}

describe('readTurnstileConfig（AC-VI-67）', () => {
  it('兩個鍵都沒設（或空字串）＝關閉', () => {
    expect(readTurnstileConfig({})).toEqual({ enabled: false })
    expect(readTurnstileConfig({ TURNSTILE_SITE_KEY: '', TURNSTILE_SECRET_KEY: ' ' })).toEqual({ enabled: false })
    expect(turnstileSiteKey({})).toBeNull()
  })

  it('兩個都設＝啟用，site key 交給前台', () => {
    const env = { TURNSTILE_SITE_KEY: 'a', TURNSTILE_SECRET_KEY: 'b' }
    expect(readTurnstileConfig(env)).toEqual({ enabled: true, siteKey: 'a', secretKey: 'b' })
    expect(turnstileSiteKey(env)).toBe('a')
  })

  it('只設一個就丟錯，訊息只講缺哪個鍵、不帶值', () => {
    expect(() => readTurnstileConfig({ TURNSTILE_SITE_KEY: 'a' })).toThrow(/缺 TURNSTILE_SECRET_KEY/)
    expect(() => readTurnstileConfig({ TURNSTILE_SECRET_KEY: 'shh' })).toThrow(/缺 TURNSTILE_SITE_KEY/)
    expect(() => readTurnstileConfig({ TURNSTILE_SECRET_KEY: 'shh' })).not.toThrow(/shh/)
  })
})

describe('verifyTurnstile', () => {
  it('功能關閉：不打 siteverify，直接放行', async () => {
    const fetch = reply({})
    await expect(verifyTurnstile(undefined, null, 'signup', { config: { enabled: false }, fetch })).resolves.toEqual({
      ok: true,
      skipped: true,
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('成功：送 secret、response、remoteip、idempotency_key，比對 action 與 hostname', async () => {
    const fetch = reply({ success: true, action: 'signup', hostname: HOST })
    const verdict = await verifyTurnstile('tok', '203.0.113.9', 'signup', { config: REAL, fetch, expectedHostname: HOST })
    expect(verdict).toEqual({ ok: true, skipped: false })

    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe(SITEVERIFY_URL)
    expect(init?.method).toBe('POST')
    const body = init?.body as URLSearchParams
    expect(body.get('secret')).toBe('secret-real')
    expect(body.get('response')).toBe('tok')
    expect(body.get('remoteip')).toBe('203.0.113.9')
    expect(body.get('idempotency_key')).toMatch(/^[0-9a-f-]{36}$/)
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('缺 token、空白、超過 2048 字：不送出，直接 missing-token', async () => {
    const fetch = reply({ success: true })
    for (const token of [undefined, null, '', '   ', 'x'.repeat(2049)]) {
      expect(await verifyTurnstile(token, null, 'reset', { config: REAL, fetch, expectedHostname: HOST })).toEqual({
        ok: false,
        reason: 'missing-token',
      })
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('Cloudflare 說失敗（隨機 token）→ rejected', async () => {
    const fetch = reply({ success: false, 'error-codes': ['invalid-input-response'] })
    expect(await verifyTurnstile('random', null, 'signup', { config: REAL, fetch, expectedHostname: HOST })).toEqual({
      ok: false,
      reason: 'rejected',
      errorCodes: ['invalid-input-response'],
    })
  })

  it('同一個 token 第二次（timeout-or-duplicate）→ rejected', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, action: 'resend', hostname: HOST })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: false, 'error-codes': ['timeout-or-duplicate'] })))
    const opts = { config: REAL, fetch, expectedHostname: HOST }
    expect((await verifyTurnstile('same', null, 'resend', opts)).ok).toBe(true)
    expect(await verifyTurnstile('same', null, 'resend', opts)).toEqual({
      ok: false,
      reason: 'rejected',
      errorCodes: ['timeout-or-duplicate'],
    })
  })

  it('action 不符（拿註冊的 token 去重設密碼）→ action-mismatch', async () => {
    const fetch = reply({ success: true, action: 'signup', hostname: HOST })
    expect(await verifyTurnstile('tok', null, 'reset', { config: REAL, fetch, expectedHostname: HOST })).toEqual({
      ok: false,
      reason: 'action-mismatch',
    })
  })

  it('hostname 不符，或伺服器不知道自己的 hostname → hostname-mismatch', async () => {
    const fetch = reply({ success: true, action: 'signup', hostname: 'evil.example' })
    expect(await verifyTurnstile('tok', null, 'signup', { config: REAL, fetch, expectedHostname: HOST })).toEqual({
      ok: false,
      reason: 'hostname-mismatch',
    })
    const ok = reply({ success: true, action: 'signup', hostname: HOST })
    expect(await verifyTurnstile('tok', null, 'signup', { config: REAL, fetch: ok, expectedHostname: null })).toEqual({
      ok: false,
      reason: 'hostname-mismatch',
    })
  })

  it('預設 hostname 取 BETTER_AUTH_URL', async () => {
    vi.stubEnv('BETTER_AUTH_URL', `https://${HOST}`)
    try {
      const fetch = reply({ success: true, action: 'signup', hostname: HOST })
      expect((await verifyTurnstile('tok', null, 'signup', { config: REAL, fetch })).ok).toBe(true)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('逾時（5 秒）→ unavailable（fail closed）', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
        }),
    )
    expect(await verifyTurnstile('tok', null, 'signup', { config: REAL, fetch, expectedHostname: HOST, timeoutMs: 20 })).toEqual({
      ok: false,
      reason: 'unavailable',
    })
  })

  it('連不上、5xx、回應不是 JSON → unavailable', async () => {
    const opts = { config: REAL, expectedHostname: HOST }
    const down = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed')
    })
    expect(await verifyTurnstile('tok', null, 'signup', { ...opts, fetch: down })).toEqual({ ok: false, reason: 'unavailable' })
    expect(await verifyTurnstile('tok', null, 'signup', { ...opts, fetch: reply({}, 502) })).toEqual({
      ok: false,
      reason: 'unavailable',
    })
    const html = vi.fn<typeof fetch>(async () => new Response('<html>', { status: 200 }))
    expect(await verifyTurnstile('tok', null, 'signup', { ...opts, fetch: html })).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('Cloudflare 測試 secret：只看 success，不比對假的 action／hostname', async () => {
    const pass: TurnstileConfig = { enabled: true, siteKey: '1x00000000000000000000AA', secretKey: '1x0000000000000000000000000000000AA' }
    const fetch = reply({ success: true, action: '', hostname: 'example.com' })
    expect(await verifyTurnstile('XXXX.DUMMY.TOKEN.XXXX', null, 'signup', { config: pass, fetch, expectedHostname: HOST })).toEqual({
      ok: true,
      skipped: false,
    })
    const fail: TurnstileConfig = { ...pass, secretKey: '2x0000000000000000000000000000000AA' }
    const rejected = reply({ success: false, 'error-codes': ['invalid-input-response'] })
    expect((await verifyTurnstile('XXXX.DUMMY.TOKEN.XXXX', null, 'signup', { config: fail, fetch: rejected })).ok).toBe(false)
  })
})
