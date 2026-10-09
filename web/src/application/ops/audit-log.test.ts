import { describe, expect, it } from 'vitest'
import {
  AUDIT_WHO_FILTERS,
  AUDIT_WHO_LABEL,
  auditActionLabel,
  auditWhoOf,
  describeAuditTarget,
  normalizeAuditWho,
} from '@/application/ops/audit-log'

describe('操作紀錄的顯示規則（票 36）', () => {
  it('分頁參數：只收六個值，其他一律回「全部」', () => {
    expect(normalizeAuditWho('teacher')).toBe('teacher')
    expect(normalizeAuditWho('other')).toBe('other')
    expect(normalizeAuditWho(['system', 'admin'])).toBe('system')
    expect(normalizeAuditWho('root')).toBe('all')
    expect(normalizeAuditWho(undefined)).toBe('all')
  })

  it('系統與背景工作歸「系統」；沒有角色的本人動作歸「本人申請」', () => {
    expect(auditWhoOf({ actorKind: 'worker', role: null })).toBe('system')
    expect(auditWhoOf({ actorKind: 'system', role: null })).toBe('system')
    expect(auditWhoOf({ actorKind: 'user', role: 'admin' })).toBe('admin')
    expect(auditWhoOf({ actorKind: 'user', role: null })).toBe('other')
  })

  it('系3：每一筆都恰好落在一個非「全部」分頁，分頁數字加起來等於全部', () => {
    const samples = [
      { actorKind: 'user', role: 'admin' },
      { actorKind: 'user', role: 'teacher' },
      { actorKind: 'user', role: 'student' },
      { actorKind: 'user', role: null },
      { actorKind: 'system', role: null },
      { actorKind: 'worker', role: null },
    ] as const
    const tabs = AUDIT_WHO_FILTERS.filter((w) => w !== 'all')
    for (const s of samples) expect(tabs).toContain(auditWhoOf(s))
    expect(AUDIT_WHO_LABEL.other).toBe('本人申請')
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

  it('系1：屆別有名稱就寫名稱，沒有才退回代碼', () => {
    expect(describeAuditTarget({ targetType: 'group', targetName: 'G03', cohortCode: '115', cohortName: '115 學年' })).toBe(
      '組別・G03（115 學年）',
    )
    expect(describeAuditTarget({ targetType: 'group', targetName: 'G03', cohortCode: '115', cohortName: ' ' })).toBe('組別・G03（115）')
    expect(
      describeAuditTarget({ targetType: 'cohort', targetName: '115 學年（115）', cohortCode: '115', cohortName: '115 學年' }),
    ).toBe('屆別・115 學年（115）')
  })
})
