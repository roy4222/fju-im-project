import { describe, expect, it } from 'vitest'
import {
  expectedBannedFor,
  nextReconcileRound,
  reachesReconcileLimit,
  RECONCILE_ROUND_LIMIT,
  revocationKindFor,
  revocationTargetOf,
} from '@/application/accounts'

/** 模組 01 附錄 A `session_revocations` 規則 5 的純規則（票 12：背景工作週期核對）。 */
describe('撤 session 的收斂規則', () => {
  it('業務狀態 → 應有的 banned；待審跟 active 一樣不封鎖（孤兒停用後恢復回待審要能登入）', () => {
    expect(expectedBannedFor('disabled')).toBe(true)
    expect(expectedBannedFor('deidentified')).toBe(true)
    expect(expectedBannedFor('active')).toBe(false)
    expect(expectedBannedFor('pending')).toBe(false)
  })

  it('目標狀態 → 工作種類', () => {
    expect(revocationKindFor('disabled')).toBe('ban')
    expect(revocationKindFor('active')).toBe('unban')
    expect(revocationKindFor('deidentified')).toBe('revoke_all')
    expect(revocationTargetOf('pending')).toBe('active')
  })

  it('自動收斂輪次 +1；manual_retry 沿用前一筆；沒有前一筆從 1 開始', () => {
    expect(nextReconcileRound(null, 'periodic')).toBe(1)
    expect(nextReconcileRound(3, 'periodic')).toBe(4)
    expect(nextReconcileRound(3, 'after_completion')).toBe(4)
    expect(nextReconcileRound(3, 'manual_retry')).toBe(3)
    expect(nextReconcileRound(null, 'manual_retry')).toBe(1)
  })

  it('自動輪次到 10 才算到上限；manual_retry 不受上限限制', () => {
    expect(reachesReconcileLimit(RECONCILE_ROUND_LIMIT - 1, 'periodic')).toBe(false)
    expect(reachesReconcileLimit(RECONCILE_ROUND_LIMIT, 'periodic')).toBe(true)
    expect(reachesReconcileLimit(RECONCILE_ROUND_LIMIT, 'manual_retry')).toBe(false)
  })
})
