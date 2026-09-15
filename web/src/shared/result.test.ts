import { describe, expect, it } from 'vitest'
import { err, isErr, isOk, ok, unwrap } from '@/shared/result'

describe('Result', () => {
  it('成功一定帶 requestId 與 serverTime', () => {
    const result = ok(
      { submissionId: 'sub_1', receivedAt: '2026-11-15T15:59:00.000Z' },
      { requestId: 'req_1', serverTime: '2026-11-15T15:59:00.100Z' },
    )
    expect(isOk(result)).toBe(true)
    expect(result.receipt).toEqual({
      submissionId: 'sub_1',
      receivedAt: '2026-11-15T15:59:00.000Z',
      requestId: 'req_1',
      serverTime: '2026-11-15T15:59:00.100Z',
    })
  })

  it('失敗帶錯誤碼並自動補契約 02 §1 的下一步', () => {
    const result = err('DEADLINE_PASSED', '已超過截止時間')
    expect(isErr(result)).toBe(true)
    expect(result).toMatchObject({ ok: false, code: 'DEADLINE_PASSED', next: { kind: 'reload' } })
  })

  it('可以指定下一步與細節，沒給 details 就不要有這個鍵', () => {
    expect(err('CONFLICT', '版本已更新', { details: { revision: 3 } }).details).toEqual({ revision: 3 })
    expect('details' in err('CONFLICT', '版本已更新')).toBe(false)
    expect(err('INTERNAL', '未知', { next: { kind: 'query_result', href: '/results/req_1' } }).next).toEqual({
      kind: 'query_result',
      href: '/results/req_1',
    })
  })

  it('unwrap 對失敗結果會丟錯，不會回 undefined', () => {
    expect(unwrap(ok({ a: 1 }, { requestId: 'r', serverTime: 's' })).a).toBe(1)
    expect(() => unwrap(err('FORBIDDEN', '沒有權限'))).toThrow(/FORBIDDEN/)
  })
})
