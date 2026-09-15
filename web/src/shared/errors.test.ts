import { describe, expect, it } from 'vitest'
import {
  CLIENT_ONLY_STATUS,
  ERROR_CODES,
  defaultNextStep,
  errorCategory,
  isErrorCode,
  type ErrorCode,
} from '@/shared/errors'

describe('錯誤碼清單（契約 02 §1）', () => {
  it('沒有重複代碼', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length)
  })

  it('每個代碼都有分類', () => {
    for (const code of ERROR_CODES) {
      expect(errorCategory(code)).toBeTruthy()
    }
  })

  it('契約 02 §1 逐格點名的代碼都在清單裡', () => {
    const fromContract: ErrorCode[] = [
      'UNAUTHENTICATED',
      'ACCOUNT_PENDING',
      'ACCOUNT_DISABLED',
      'PASSWORD_CHANGE_REQUIRED',
      'FRESH_SESSION_REQUIRED',
      'TURNSTILE_REQUIRED',
      'FORBIDDEN',
      'NOT_IN_ROSTER',
      'COHORT_ARCHIVED',
      'DEADLINE_PASSED',
      'VERSION_SUPERSEDED',
      'SCHEME_LOCKED',
      'FINAL_INCOMPLETE',
      'CONFLICT',
      'REQUEST_MISMATCH',
      'VALIDATION_FAILED',
      'FILE_TOO_LARGE',
      'RECEIPT_EXPIRED',
      'INTERNAL',
    ]
    for (const code of fromContract) {
      expect(isErrorCode(code)).toBe(true)
    }
    // 契約 02 §1 七個分類逐格點數：身分 6、授權 8、狀態 19、併發 2、輸入 7、帳本 1、系統 1。
    expect(ERROR_CODES).toHaveLength(44)
    const perCategory = ERROR_CODES.reduce<Record<string, number>>((acc, code) => {
      acc[errorCategory(code)] = (acc[errorCategory(code)] ?? 0) + 1
      return acc
    }, {})
    expect(perCategory).toEqual({
      identity: 6,
      authorization: 8,
      state: 19,
      concurrency: 2,
      input: 7,
      ledger: 1,
      system: 1,
    })
  })

  it('身分類錯誤各自導到對的頁', () => {
    expect(defaultNextStep('UNAUTHENTICATED')).toEqual({ kind: 'login' })
    expect(defaultNextStep('ACCOUNT_PENDING')).toEqual({ kind: 'pending_page' })
    expect(defaultNextStep('ACCOUNT_DISABLED')).toEqual({ kind: 'contact_office' })
    expect(defaultNextStep('PASSWORD_CHANGE_REQUIRED')).toEqual({ kind: 'change_password' })
  })

  it('REQUEST_MISMATCH 不自動重試', () => {
    expect(defaultNextStep('REQUEST_MISMATCH')).toEqual({ kind: 'reload' })
  })

  it('狀態與併發類預設 reload，授權類回首頁', () => {
    expect(defaultNextStep('DEADLINE_PASSED')).toEqual({ kind: 'reload' })
    expect(defaultNextStep('CONFLICT')).toEqual({ kind: 'reload' })
    expect(defaultNextStep('FORBIDDEN')).toEqual({ kind: 'home' })
  })

  it('RESULT_UNKNOWN 是前端狀態，不是伺服器錯誤碼', () => {
    expect(isErrorCode(CLIENT_ONLY_STATUS)).toBe(false)
  })

  it('不認得的字串不是錯誤碼', () => {
    expect(isErrorCode('NOPE')).toBe(false)
    expect(isErrorCode(42)).toBe(false)
  })
})
