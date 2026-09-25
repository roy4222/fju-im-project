import { describe, expect, it } from 'vitest'
import { auditActionLabel, auditWhoOf, describeAuditTarget, normalizeAuditWho } from '@/application/ops/audit-log'

describe('操作紀錄的顯示規則（票 36）', () => {
  it('分頁參數：只收五個值，其他一律回「全部」', () => {
    expect(normalizeAuditWho('teacher')).toBe('teacher')
    expect(normalizeAuditWho(['system', 'admin'])).toBe('system')
    expect(normalizeAuditWho('root')).toBe('all')
    expect(normalizeAuditWho(undefined)).toBe('all')
  })

  it('系統與背景工作歸「系統」；本人動作沒有角色', () => {
    expect(auditWhoOf({ actorKind: 'worker', role: null })).toBe('system')
    expect(auditWhoOf({ actorKind: 'system', role: null })).toBe('system')
    expect(auditWhoOf({ actorKind: 'user', role: 'admin' })).toBe('admin')
    expect(auditWhoOf({ actorKind: 'user', role: null })).toBeNull()
  })

  it('動作有中文；沒登記的照原代碼顯示', () => {
    expect(auditActionLabel('grading.override')).toBe('更正成績')
    expect(auditActionLabel('something.new')).toBe('something.new')
  })

  it('對象：類型＋名字＋屆別代碼；屆別本身不重複寫', () => {
    expect(describeAuditTarget({ targetType: 'user', targetName: '王小明', cohortCode: null })).toBe('帳號・王小明')
    expect(describeAuditTarget({ targetType: 'group', targetName: 'G03', cohortCode: '115' })).toBe('組別・G03（115）')
    expect(describeAuditTarget({ targetType: 'cohort', targetName: '115', cohortCode: '115' })).toBe('屆別・115')
    expect(describeAuditTarget({ targetType: 'evaluation', targetName: null, cohortCode: null })).toBe('評分')
  })
})
