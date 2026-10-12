import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AUDIT_UNKNOWN_ACTION_LABEL,
  AUDIT_WHO_FILTERS,
  AUDIT_WHO_LABEL,
  auditActionLabel,
  auditActionTitle,
  hasAuditActionLabel,
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

  it('動作有中文；沒登記的顯示「其他操作」，原代碼只放在滑過提示（第三波 Q26）', () => {
    expect(auditActionLabel('grading.override')).toBe('更正成績')
    expect(auditActionTitle('grading.override')).toBeUndefined()
    expect(auditActionLabel('something.new')).toBe(AUDIT_UNKNOWN_ACTION_LABEL)
    expect(AUDIT_UNKNOWN_ACTION_LABEL).toBe('其他操作')
    expect(auditActionTitle('something.new')).toBe('something.new')
    // 物件原型上的名字不能被當成「有登記」。
    expect(auditActionLabel('toString')).toBe('其他操作')
  })

  it('驗收時看到英文代碼的那幾筆（N-124、N-125、N-126）與第三波新代碼都有中文', () => {
    expect(auditActionLabel('item.republish')).toBe('重新發布專題事務')
    expect(auditActionLabel('item.archive')).toBe('下架專題事務')
    expect(auditActionLabel('account.seed_e2e_admin')).toBe('建立測試管理員帳號')
    expect(auditActionLabel('account.seed_first_admin')).toBe('建立第一位管理員')
    expect(auditActionLabel('cohort.set_registration_open')).toBe('設定開放註冊屆別')
    for (const code of [
      'item.deleted',
      'home.updated',
      'activity.deleted',
      'opportunity.deleted',
      'submission.reopen',
      'showcase.published',
      'showcase.withdrawn',
      'showcase.republished',
      'showcase.award_set',
      'showcase.deleted',
    ]) {
      expect(hasAuditActionLabel(code), code).toBe(true)
    }
  })

  it('程式裡出現的每一個動作代碼都登記了中文（新增代碼忘了登記，這裡會紅）', () => {
    // 跟方案 §10 取清單的 grep 同一個樣式：`'(item|account|…)\.[a-z_]+'`。
    const pattern = /'((?:item|account|cohort|opportunity|showcase|activity|home|submission|registration)\.[a-z_]+)'/g
    const root = join(import.meta.dirname, '..', '..')
    const codes = new Set<string>()
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue
      for (const m of readFileSync(join(entry.parentPath, entry.name), 'utf8').matchAll(pattern)) codes.add(m[1]!)
    }
    // 樣式抓不到、由程式組出來的代碼（`item.${action}`、`opportunity.${kind}`）另外列。
    for (const code of ['item.withdraw', 'item.archive', 'item.republish', 'opportunity.publish', 'opportunity.withdraw']) codes.add(code)
    expect(codes.size).toBeGreaterThan(40)
    const missing = [...codes].filter((code) => !hasAuditActionLabel(code)).sort()
    expect(missing).toEqual([])
  })

  it('對象：類型＋名字＋屆別代碼；屆別本身不重複寫', () => {
    expect(describeAuditTarget({ targetType: 'user', targetName: '王小明', cohortCode: null })).toBe('帳號・王小明')
    expect(describeAuditTarget({ targetType: 'group', targetName: 'G03', cohortCode: '115' })).toBe('組別・G03（115）')
    expect(describeAuditTarget({ targetType: 'cohort', targetName: '115', cohortCode: '115' })).toBe('屆別・115')
    expect(describeAuditTarget({ targetType: 'evaluation', targetName: null, cohortCode: null })).toBe('評分')
    expect(describeAuditTarget({ targetType: 'roster_version', targetName: null, cohortCode: '115' })).toBe('匯入的學生名單（115）')
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
