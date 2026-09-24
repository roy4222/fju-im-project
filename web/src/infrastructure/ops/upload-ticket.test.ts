import { describe, expect, it } from 'vitest'
import { issueTicket, verifyTicket } from '@/infrastructure/ops/upload-ticket'

const secret = 'unit-test-secret-unit-test-secret'
const now = new Date('2026-09-24T04:00:00Z')
const claims = {
  fileId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  userId: 'user-1',
  type: 'csv' as const,
  maxBytes: 1024,
  expiresAt: now.getTime() + 60_000,
}

describe('上傳 ticket', () => {
  it('簽了之後驗得回同一份內容', () => {
    expect(verifyTicket(issueTicket(claims, secret), secret, now)).toEqual(claims)
  })

  it('過期就無效', () => {
    const ticket = issueTicket(claims, secret)
    expect(verifyTicket(ticket, secret, new Date(claims.expiresAt))).toBeNull()
  })

  it('換一把秘密驗不過', () => {
    expect(verifyTicket(issueTicket(claims, secret), 'another-secret-another-secret-xx', now)).toBeNull()
  })

  it('竄改內容（例如把上限改大）簽章就對不上', () => {
    const ticket = issueTicket(claims, secret)
    const [, signature] = ticket.split('.')
    const forged = Buffer.from(
      JSON.stringify({ f: claims.fileId, u: claims.userId, t: 'csv', m: 10 ** 9, e: claims.expiresAt }),
    ).toString('base64url')
    expect(verifyTicket(`${forged}.${signature}`, secret, now)).toBeNull()
  })

  it('格式不對一律 null', () => {
    for (const bad of ['', 'abc', 'a.b.c', '.', 'x'.repeat(2000)]) {
      expect(verifyTicket(bad, secret, now)).toBeNull()
    }
  })
})
