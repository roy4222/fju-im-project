import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RATE_LIMITS } from '@/shared/rate-limit'
import {
  checkIpFailures,
  checkSignInRate,
  recordIpFailure,
  resetSignInLimiter,
  resetSignInRate,
  signInKey,
} from '@/infrastructure/auth/sign-in-rate-limit'

/** 票 T3：每 IP 跨帳號登入失敗限速（Roy 2026-10-08 定案：30 次失敗／10 分鐘）。 */

const MAX = RATE_LIMITS.signInFailuresPerIp.max
const WINDOW = RATE_LIMITS.signInFailuresPerIp.windowMs

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-08T12:00:00Z'))
  resetSignInLimiter()
})

afterEach(() => {
  vi.useRealTimers()
})

function fail(ip: string, times: number) {
  for (let i = 0; i < times; i += 1) recordIpFailure(ip)
}

describe('每 IP 失敗桶', () => {
  it('門檻是 30 次／10 分鐘', () => {
    expect(MAX).toBe(30)
    expect(WINDOW).toBe(10 * 60 * 1000)
  })

  it('失敗 29 次還放行，第 30 次失敗之後就擋', () => {
    fail('203.0.113.1', MAX - 1)
    expect(checkIpFailures('203.0.113.1').allowed).toBe(true)
    recordIpFailure('203.0.113.1')
    expect(checkIpFailures('203.0.113.1').allowed).toBe(false)
  })

  it('只看不計：查很多次不會把自己查到被擋', () => {
    for (let i = 0; i < MAX * 2; i += 1) expect(checkIpFailures('203.0.113.2').allowed).toBe(true)
  })

  it('換一個 IP 不受影響', () => {
    fail('203.0.113.3', MAX)
    expect(checkIpFailures('203.0.113.3').allowed).toBe(false)
    expect(checkIpFailures('198.51.100.3').allowed).toBe(true)
  })

  it('10 分鐘後解除', () => {
    fail('203.0.113.4', MAX)
    vi.advanceTimersByTime(WINDOW - 1)
    expect(checkIpFailures('203.0.113.4').allowed).toBe(false)
    vi.advanceTimersByTime(1)
    expect(checkIpFailures('203.0.113.4').allowed).toBe(true)
    // 解除之後重新從 0 算
    fail('203.0.113.4', MAX - 1)
    expect(checkIpFailures('203.0.113.4').allowed).toBe(true)
  })

  it('成功登入（清帳號桶）不會清掉 IP 桶，也不算一次失敗', () => {
    fail('203.0.113.5', MAX - 1)
    resetSignInRate(signInKey('203.0.113.5', 'someone@example.com'))
    expect(checkIpFailures('203.0.113.5').allowed).toBe(true)
    recordIpFailure('203.0.113.5')
    expect(checkIpFailures('203.0.113.5').allowed).toBe(false)
  })

  it('resetSignInLimiter 連 IP 桶一起清', () => {
    fail('203.0.113.6', MAX)
    resetSignInLimiter()
    expect(checkIpFailures('203.0.113.6').allowed).toBe(true)
  })
})

describe('既有的 IP＋帳號桶照舊', () => {
  it('同一 IP 同一帳號 10 次之後第 11 次擋，跟 IP 桶各算各的', () => {
    const key = signInKey('203.0.113.7', 'Alice@Example.com')
    for (let i = 0; i < RATE_LIMITS.signIn.max; i += 1) expect(checkSignInRate(key).allowed).toBe(true)
    expect(checkSignInRate(key).allowed).toBe(false)
    expect(checkSignInRate(signInKey('203.0.113.7', 'bob@example.com')).allowed).toBe(true)
    expect(checkIpFailures('203.0.113.7').allowed).toBe(true)
  })
})
