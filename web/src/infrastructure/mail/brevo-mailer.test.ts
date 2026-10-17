import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import { emailOtpMail, passwordResetMail } from '@/application/mail'
import { BREVO_ENDPOINT, BrevoMailer, parseSender } from '@/infrastructure/mail/brevo-mailer'

/**
 * AC-VI-76 的 Brevo 段（設計方案 §3.1）：用假的 fetch 與記錄 SQL 的假連線，不打外部、不碰資料庫。
 * 要證明：正式列 `body_text` 一律 NULL；`error` 只有 `brevo_<狀態>_<code>`／`timeout`，不含金鑰、內文、token；
 * 缺設定回 `MAIL_NOT_CONFIGURED` 而且不降級為擷取。
 */

const API_KEY = 'xkeysib-very-secret-key'
const OTP = '482913'
const RESET_URL = 'https://test.fju.roy422.dev/reset-password?token=tok_secret_123'

type Recorded = { sql: string; values: unknown[] }

function fakeDb() {
  const queries: Recorded[] = []
  const pool = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values })
      return { rows: [], rowCount: 1 }
    }),
  } as unknown as Pool
  return { pool, queries }
}

function mailer(fetchImpl: typeof fetch, config: { apiKey?: string; from?: string; replyTo?: string } = {}) {
  const db = fakeDb()
  const instance = new BrevoMailer({
    db: () => db.pool,
    config: { apiKey: API_KEY, from: '專題管理平台 <noreply@roy422.dev>', ...config },
    fetch: fetchImpl,
    timeoutMs: 50,
  })
  return { instance, ...db }
}

const message = { to: 's1@example.com', ...emailOtpMail(OTP) }

/** 所有寫進資料庫的值串起來：金鑰、碼、token 都不可以出現。 */
function persisted(queries: Recorded[]): string {
  return JSON.stringify(queries.map((q) => q.values))
}

describe('BrevoMailer', () => {
  it('成功：先插 queued（body_text NULL）、再標 sent 並記 messageId；請求帶金鑰標頭與寄件人', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ messageId: '<abc@smtp-relay.brevo.com>' }), { status: 201 }))
    const { instance, queries } = mailer(fetchImpl as unknown as typeof fetch, { replyTo: 'office@example.com' })
    const result = await instance.send(message)

    expect(result).toMatchObject({ ok: true, status: 'sent' })
    expect(queries[0]!.sql).toMatch(/insert into mail_outbox/)
    // values：id, to, template, subject, body_text, status, error, created_at, sent_at
    expect(queries[0]!.values.slice(1, 7)).toEqual(['s1@example.com', 'email_otp', '【專題管理平台】Email 驗證碼', null, 'queued', null])
    expect(queries[1]!.sql).toMatch(/set status = 'sent'/)
    expect(queries[1]!.values[1]).toBe('<abc@smtp-relay.brevo.com>')

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(BREVO_ENDPOINT)
    expect((init.headers as Record<string, string>)['api-key']).toBe(API_KEY)
    expect(JSON.parse(String(init.body))).toEqual({
      sender: { name: '專題管理平台', email: 'noreply@roy422.dev' },
      to: [{ email: 's1@example.com' }],
      subject: '【專題管理平台】Email 驗證碼',
      textContent: message.text,
      replyTo: { email: 'office@example.com' },
    })
    expect(persisted(queries)).not.toContain(OTP)
    expect(persisted(queries)).not.toContain(API_KEY)
  })

  it('Brevo 回 4xx：標 failed，error 只有 brevo_<狀態>_<code>，回 MAIL_FAILED', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 'unauthorized', message: `Key not found: ${API_KEY} ${RESET_URL}` }), {
          status: 401,
        }),
    )
    const { instance, queries } = mailer(fetchImpl as unknown as typeof fetch)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const result = await instance.send({ to: 's1@example.com', ...passwordResetMail(RESET_URL) })

    expect(result).toMatchObject({ ok: false, code: 'MAIL_FAILED' })
    expect(queries[1]!.sql).toMatch(/set status = 'failed'/)
    expect(queries[1]!.values[1]).toBe('brevo_401_unauthorized')
    expect(queries[0]!.values[4]).toBeNull()
    expect(persisted(queries)).not.toContain('tok_secret_123')
    expect(persisted(queries)).not.toContain(API_KEY)
    // log 也不帶金鑰、內文、token。
    const logged = JSON.stringify(errors.mock.calls)
    expect(logged).not.toContain(API_KEY)
    expect(logged).not.toContain('tok_secret_123')
    errors.mockRestore()
  })

  it('Brevo 錯誤碼裡的怪字元被拿掉；沒有 code 記 unknown', async () => {
    const weird = vi.fn(async () => new Response(JSON.stringify({ code: 'bad<script>"x y' }), { status: 400 }))
    const { instance, queries } = mailer(weird as unknown as typeof fetch)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await instance.send(message)
    expect(queries[1]!.values[1]).toBe('brevo_400_badscriptxy')

    const html = vi.fn(async () => new Response('<html>gateway</html>', { status: 502 }))
    const second = mailer(html as unknown as typeof fetch)
    await second.instance.send(message)
    expect(second.queries[1]!.values[1]).toBe('brevo_502_unknown')
    vi.restoreAllMocks()
  })

  it('逾時：error = timeout，回 MAIL_FAILED', async () => {
    const hang = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        }),
    )
    const { instance, queries } = mailer(hang as unknown as typeof fetch)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const result = await instance.send(message)
    expect(result).toMatchObject({ ok: false, code: 'MAIL_FAILED' })
    expect(queries[1]!.values[1]).toBe('timeout')
    vi.restoreAllMocks()
  })

  it.each([
    ['少了 BREVO_API_KEY', { apiKey: '' }],
    ['少了 MAIL_FROM', { from: '' }],
    ['MAIL_FROM 格式不對', { from: '專題管理平台' }],
  ])('%s：不打 Brevo、一列 failed／not_configured、body_text NULL，回 MAIL_NOT_CONFIGURED（不降級為擷取）', async (_label, config) => {
    const fetchImpl = vi.fn()
    const { instance, queries } = mailer(fetchImpl as unknown as typeof fetch, config)
    const result = await instance.send(message)
    expect(result).toMatchObject({ ok: false, code: 'MAIL_NOT_CONFIGURED' })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(queries).toHaveLength(1)
    expect(queries[0]!.values.slice(4, 7)).toEqual([null, 'failed', 'not_configured'])
  })
})

describe('parseSender', () => {
  it('拆「名稱 <email>」；單純 Email 也可以；壞格式回 null', () => {
    expect(parseSender('專題管理平台 <noreply@roy422.dev>')).toEqual({ name: '專題管理平台', email: 'noreply@roy422.dev' })
    expect(parseSender('"專題管理平台" <noreply@roy422.dev>')).toEqual({ name: '專題管理平台', email: 'noreply@roy422.dev' })
    expect(parseSender('noreply@roy422.dev')).toEqual({ email: 'noreply@roy422.dev' })
    expect(parseSender('專題管理平台')).toBeNull()
  })
})
