import { describe, expect, it } from 'vitest'
import type { ResolvedActor } from '@/application/accounts'
import { requestSubmissionUpload } from '@/composition/submissions'
import { createRateLimiter } from '@/shared/rate-limit'

/**
 * 票 21：學生要上傳憑證要限速（契約 03 §6）。每張憑證都會先建一筆 `uploading` 檔案列，
 * 回收工作要到 S12 才上，不限速就能灌爆檔案表。
 */

const student: ResolvedActor = {
  kind: 'authenticated',
  userId: '0192d6a0-0000-7000-8000-000000000001',
  roles: ['student'],
  status: 'active',
  mustChangePassword: false,
  cohortMemberships: [],
}

const declared = { fileName: 'a.pdf', declaredMime: 'application/pdf', declaredSize: 10 }

describe('繳交上傳憑證限速', () => {
  it('同一個人超過額度就回 RATE_LIMITED，而且不再碰用例（不建檔案列）；別人不受影響', async () => {
    let calls = 0
    const command = {
      requestUpload: async () => {
        calls += 1
        return { ok: false as const, code: 'NOT_MEMBER' as const, message: 'x' }
      },
    }
    const limiter = createRateLimiter({ max: 2, windowMs: 60_000 })
    const deps = { command, limiter }
    await requestSubmissionUpload(student, 'item', 'report', declared, deps)
    await requestSubmissionUpload(student, 'item', 'report', declared, deps)
    const third = await requestSubmissionUpload(student, 'item', 'report', declared, deps)
    expect(third).toMatchObject({ ok: false, code: 'RATE_LIMITED' })
    expect(calls).toBe(2)

    const other = { ...student, userId: '0192d6a0-0000-7000-8000-000000000002' }
    expect(await requestSubmissionUpload(other, 'item', 'report', declared, deps)).toMatchObject({ code: 'NOT_MEMBER' })
    expect(calls).toBe(3)
  })
})
