import { describe, expect, it } from 'vitest'
import { isWorkerStale, WORKER_STALE_AFTER_MS } from '@/shared/health'

/** 契約 05 §5：背景工作心跳超過 5 分鐘沒更新視為不健康（票 12）。 */
describe('isWorkerStale', () => {
  const now = new Date('2026-09-24T00:10:00Z')

  it('從來沒有心跳：不算停擺（還沒部署 worker 的環境）', () => {
    expect(isWorkerStale({ version: null, lastTickAt: null }, now)).toBe(false)
  })

  it('5 分鐘內有心跳：正常；超過 5 分鐘：停擺', () => {
    const at = (ms: number) => new Date(now.getTime() - ms).toISOString()
    expect(isWorkerStale({ version: 'x', lastTickAt: at(WORKER_STALE_AFTER_MS) }, now)).toBe(false)
    expect(isWorkerStale({ version: 'x', lastTickAt: at(WORKER_STALE_AFTER_MS + 1) }, now)).toBe(true)
  })

  it('時間格式壞掉：當作停擺', () => {
    expect(isWorkerStale({ version: 'x', lastTickAt: 'nope' }, now)).toBe(true)
  })
})
