import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { emailOtpMail, passwordResetMail, type Mailer } from '@/application/mail'
import { BrevoMailer } from '@/infrastructure/mail/brevo-mailer'
import { CaptureMailer } from '@/infrastructure/mail/capture-mailer'
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  poolAsRole,
  TEST_DATABASE_URL,
  type IsolatedDatabase,
} from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'

/**
 * B 階段 VB-1：`mail_outbox` 與兩個轉接器打真的 PostgreSQL（設計方案 §3.1；AC-VI-46 的 `mail_outbox` 段、AC-VI-76）。
 *
 * 全程以 `fju_app` 連線（0015 的權限漏給這裡就紅）。Brevo 用假的 fetch，不打外部。
 * 也驗整合測試的 setup 檔確實把 composition 切到擷取模式。
 */

const OTP = '731946'
let db: IsolatedDatabase
let app: Pool

beforeAll(async () => {
  await assertTestDatabaseReachable()
  db = await createIsolatedDatabase({ label: 'vb1-mail-outbox', setup: migratedSchema })
  app = await poolAsRole(db, 'fju_app')
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await app?.end()
  await db?.close()
})

const rowOf = async (id: string) =>
  (
    await db.sql(
      `select to_email, template, subject, body_text, status, provider_message_id, error, sent_at is not null as has_sent_at
         from mail_outbox where id = $1`,
      [id],
    )
  ).rows[0]

describe('mail_outbox', () => {
  it('擷取模式：一列 captured、body_text 存全文（e2e 從這裡讀驗證碼）；主旨不含碼', async () => {
    const mailer = new CaptureMailer({ db: () => app })
    const result = await mailer.send({ to: 's1@example.com', ...emailOtpMail(OTP) })
    if (!result.ok) throw new Error(result.code)
    expect(result.status).toBe('captured')
    const row = await rowOf(result.outboxId)
    expect(row).toEqual({
      to_email: 's1@example.com',
      template: 'email_otp',
      subject: '【專題管理平台】Email 驗證碼',
      body_text: `你的驗證碼是 ${OTP}，10 分鐘內有效。如果這不是你本人的操作，請忽略這封信。`,
      status: 'captured',
      provider_message_id: null,
      error: null,
      has_sent_at: true,
    })
    expect(row!.subject).not.toMatch(/\d{6}/)
  })

  it('Brevo 寄出：sent、記 messageId、body_text NULL（正式列不存內文）', async () => {
    const mailer = new BrevoMailer({
      db: () => app,
      config: { apiKey: 'fake-key', from: '專題管理平台 <noreply@roy422.dev>' },
      fetch: async () => new Response(JSON.stringify({ messageId: '<m1@smtp-relay.brevo.com>' }), { status: 201 }),
    })
    const url = 'http://127.0.0.1:3000/reset-password?token=tok_abc'
    const result = await mailer.send({ to: 's2@example.com', ...passwordResetMail(url) })
    if (!result.ok) throw new Error(result.code)
    expect(await rowOf(result.outboxId)).toEqual({
      to_email: 's2@example.com',
      template: 'password_reset',
      subject: '【專題管理平台】重設密碼',
      body_text: null,
      status: 'sent',
      provider_message_id: '<m1@smtp-relay.brevo.com>',
      error: null,
      has_sent_at: true,
    })
  })

  it('Brevo 少了金鑰：一列 failed／not_configured、body_text NULL，回 MAIL_NOT_CONFIGURED（不降級為擷取）', async () => {
    const mailer = new BrevoMailer({ db: () => app, config: { apiKey: undefined, from: undefined } })
    const result = await mailer.send({ to: 's3@example.com', ...emailOtpMail(OTP) })
    expect(result).toMatchObject({ ok: false, code: 'MAIL_NOT_CONFIGURED' })
    expect(await rowOf(result.outboxId)).toMatchObject({ status: 'failed', error: 'not_configured', body_text: null, has_sent_at: false })
  })

  it('CHECK 擋掉不認得的範本與狀態', async () => {
    const insert = (template: string, status: string) =>
      app.query(
        `insert into mail_outbox (id, to_email, template, subject, status) values (gen_random_uuid(), 'x@example.com', $1, 's', $2)`,
        [template, status],
      )
    await expect(insert('welcome', 'sent')).rejects.toThrow(/mail_outbox_template_check/)
    await expect(insert('email_otp', 'bounced')).rejects.toThrow(/mail_outbox_status_check/)
  })

  it('fju_app 可以刪舊列（R5：保存 90 天後由 worker 清，VB-13）', async () => {
    const mailer = new CaptureMailer({ db: () => app })
    const result = await mailer.send({ to: 'old@example.com', ...emailOtpMail(OTP) })
    const deleted = await app.query(`delete from mail_outbox where id = $1`, [result.outboxId])
    expect(deleted.rowCount).toBe(1)
  })
})

describe('composition/mail.ts 在整合測試裡', () => {
  it('setup 檔開了 MAIL_CAPTURE，BETTER_AUTH_URL 是 127.0.0.1 → getMailer() 是擷取，寫進 mail_outbox', async () => {
    expect(process.env.MAIL_CAPTURE).toBe('1')
    const url = new URL(TEST_DATABASE_URL)
    url.username = 'fju_app'
    url.password = process.env.TEST_FJU_APP_PASSWORD ?? 'fju_app_local_test'
    url.searchParams.set('options', `-c search_path=${db.schemaName}`)
    vi.resetModules()
    vi.stubEnv('DATABASE_URL', url.toString())
    vi.stubEnv('BETTER_AUTH_URL', 'http://127.0.0.1:3000')
    const { getMailer } = await import('@/composition/mail')
    const mailer: Mailer = getMailer()
    expect(mailer).toBeInstanceOf((await import('@/infrastructure/mail/capture-mailer')).CaptureMailer)
    const result = await mailer.send({ to: 'compose@example.com', ...emailOtpMail(OTP) })
    if (!result.ok) throw new Error(result.code)
    expect(await rowOf(result.outboxId)).toMatchObject({ status: 'captured', body_text: expect.stringContaining(OTP) })
    const { getPool } = await import('@/infrastructure/db/client')
    await getPool().end()
  })
})
