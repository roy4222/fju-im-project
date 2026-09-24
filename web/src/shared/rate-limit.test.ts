import { describe, expect, it } from 'vitest'
import { createRateLimiter, RATE_LIMITS, sharedRateLimiter } from '@/shared/rate-limit'

/** S01-05：契約 03 §6 的限速。 */

function limiterWithClock(max: number, windowMs: number) {
  let now = 1_000_000
  const limiter = createRateLimiter({ max, windowMs, now: () => now })
  return { limiter, advance: (ms: number) => (now += ms) }
}

describe('固定視窗', () => {
  it('前 N 次放行，第 N+1 次擋下', () => {
    const { limiter } = limiterWithClock(3, 60_000)
    expect(limiter.hit('k').allowed).toBe(true)
    expect(limiter.hit('k').allowed).toBe(true)
    expect(limiter.hit('k').allowed).toBe(true)
    expect(limiter.hit('k').allowed).toBe(false)
  })

  it('被擋下時說得出還要等多久', () => {
    const { limiter, advance } = limiterWithClock(1, 60_000)
    limiter.hit('k')
    advance(20_000)
    const verdict = limiter.hit('k')
    expect(verdict.allowed).toBe(false)
    if (verdict.allowed) throw new Error('unreachable')
    expect(verdict.retryAfterMs).toBe(40_000)
  })

  it('視窗過了就重新開始', () => {
    const { limiter, advance } = limiterWithClock(2, 60_000)
    limiter.hit('k')
    limiter.hit('k')
    expect(limiter.hit('k').allowed).toBe(false)

    advance(60_000)
    expect(limiter.hit('k').allowed).toBe(true)
  })

  it('不同的鍵互不影響（一個人被擋不會連累別人）', () => {
    const { limiter } = limiterWithClock(1, 60_000)
    limiter.hit('ip-a:alice')
    expect(limiter.hit('ip-a:alice').allowed).toBe(false)
    expect(limiter.hit('ip-a:bob').allowed).toBe(true)
    expect(limiter.hit('ip-b:alice').allowed).toBe(true)
  })

  it('成功之後 reset，計數歸零', () => {
    const { limiter } = limiterWithClock(2, 60_000)
    limiter.hit('k')
    limiter.hit('k')
    limiter.reset('k')
    expect(limiter.hit('k').allowed).toBe(true)
    expect(limiter.hit('k').allowed).toBe(true)
  })

  it('剩餘次數會遞減', () => {
    const { limiter } = limiterWithClock(3, 60_000)
    const first = limiter.hit('k')
    expect(first.allowed && first.remaining).toBe(2)
    const second = limiter.hit('k')
    expect(second.allowed && second.remaining).toBe(1)
  })
})

describe('契約 03 §6 的門檻值', () => {
  it('登入 10 次／10 分鐘', () => {
    expect(RATE_LIMITS.signIn).toEqual({ max: 10, windowMs: 600_000 })
  })

  it('改密 5 次／小時', () => {
    expect(RATE_LIMITS.changePassword).toEqual({ max: 5, windowMs: 3_600_000 })
  })

  it('註冊 30 次／小時（2026-09-23 定案，取代 5 次）：第 30 次放行、第 31 次擋，一小時後重新計算', () => {
    expect(RATE_LIMITS.register).toEqual({ max: 30, windowMs: 3_600_000 })
    let now = 0
    const limiter = createRateLimiter({ ...RATE_LIMITS.register, now: () => now })
    for (let i = 1; i <= 30; i += 1) expect(limiter.hit('register:203.0.113.9').allowed).toBe(true)
    expect(limiter.hit('register:203.0.113.9').allowed).toBe(false)
    // 別的 IP 不受影響。
    expect(limiter.hit('register:203.0.113.10').allowed).toBe(true)
    now = 3_600_000
    expect(limiter.hit('register:203.0.113.9').allowed).toBe(true)
  })
})

describe('sharedRateLimiter：同一個程序只有一份', () => {
  it('同名拿到同一個計數（Route Handler 與 Server Action 在不同 chunk 也共用），不同名互不影響', () => {
    const a = sharedRateLimiter('test-shared', { max: 1, windowMs: 60_000 })
    const b = sharedRateLimiter('test-shared', { max: 1, windowMs: 60_000 })
    expect(a).toBe(b)
    expect(a.hit('k').allowed).toBe(true)
    expect(b.hit('k').allowed).toBe(false)
    expect(sharedRateLimiter('test-other', { max: 1, windowMs: 60_000 }).hit('k').allowed).toBe(true)
  })
})
