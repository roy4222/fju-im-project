import { describe, expect, it } from 'vitest'
import { chooseMailer } from '@/composition/mail'

/** AC-VI-76：擷取模式要明確開，而且只限本機與 CI 的網址（設計方案 §3.1）。 */
describe('選寄信轉接器', () => {
  it('沒有 MAIL_CAPTURE → Brevo', () => {
    expect(chooseMailer({ BETTER_AUTH_URL: 'http://127.0.0.1:3000' })).toEqual({ kind: 'brevo', refusedCapture: false })
    expect(chooseMailer({ MAIL_CAPTURE: '0', BETTER_AUTH_URL: 'http://127.0.0.1:3000' }).kind).toBe('brevo')
  })

  it('MAIL_CAPTURE=1＋http://127.0.0.1:3000（或 localhost）→ 擷取', () => {
    expect(chooseMailer({ MAIL_CAPTURE: '1', BETTER_AUTH_URL: 'http://127.0.0.1:3000' })).toEqual({
      kind: 'capture',
      refusedCapture: false,
    })
    expect(chooseMailer({ MAIL_CAPTURE: '1', BETTER_AUTH_URL: 'http://localhost:3399' }).kind).toBe('capture')
  })

  it('MAIL_CAPTURE=1＋測試站或正式站網址 → 拒絕擷取、走 Brevo，並要求警告', () => {
    expect(chooseMailer({ MAIL_CAPTURE: '1', BETTER_AUTH_URL: 'https://stg.roy422.dev' })).toEqual({
      kind: 'brevo',
      refusedCapture: true,
    })
    expect(chooseMailer({ MAIL_CAPTURE: '1', BETTER_AUTH_URL: 'https://test.fju.roy422.dev' }).kind).toBe('brevo')
    // 主機名只是「含」localhost 不算本機。
    expect(chooseMailer({ MAIL_CAPTURE: '1', BETTER_AUTH_URL: 'https://localhost.roy422.dev' }).kind).toBe('brevo')
    // 沒設網址或網址壞掉也不擷取。
    expect(chooseMailer({ MAIL_CAPTURE: '1' }).kind).toBe('brevo')
    expect(chooseMailer({ MAIL_CAPTURE: '1', BETTER_AUTH_URL: 'not a url' }).kind).toBe('brevo')
  })
})
