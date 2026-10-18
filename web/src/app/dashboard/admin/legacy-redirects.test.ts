import { describe, expect, it } from 'vitest'
import { legacyAdminRedirect } from './legacy-redirects'

// 舊網址 → 新網址（設計方案 §8；AC-C2-03、AC-C2-06）：純函式，頁面先守衛再用它決定要不要 redirect。
describe('legacyAdminRedirect', () => {
  it('設定入口頁轉到屆別', () => {
    expect(legacyAdminRedirect('/dashboard/admin/settings')).toBe('/dashboard/admin/cohorts')
  })

  it('設定入口頁帶的 query 照帶', () => {
    expect(legacyAdminRedirect('/dashboard/admin/settings', { cohort: '115' })).toBe('/dashboard/admin/cohorts?cohort=115')
  })

  it('?placement= 四種舊篩選轉到對應分頁，placement 拿掉、其餘 query 照帶', () => {
    expect(legacyAdminRedirect('/dashboard/admin/affairs', { placement: 'resource', cohort: '115' })).toBe(
      '/dashboard/admin/affairs/resources?cohort=115',
    )
    expect(legacyAdminRedirect('/dashboard/admin/affairs', { placement: 'submission' })).toBe('/dashboard/admin/affairs/assignments')
    expect(legacyAdminRedirect('/dashboard/admin/affairs', { placement: 'requirement' })).toBe('/dashboard/admin/affairs/assignments')
    expect(legacyAdminRedirect('/dashboard/admin/affairs', { cohort: 'c-1', placement: 'rules' })).toBe(
      '/dashboard/admin/affairs/rules?cohort=c-1',
    )
  })

  it('重複的 query 與要編碼的字照帶', () => {
    expect(legacyAdminRedirect('/dashboard/admin/affairs', { placement: 'resource', tag: ['a', 'b c'], q: '王' })).toBe(
      '/dashboard/admin/affairs/resources?tag=a&tag=b+c&q=%E7%8E%8B',
    )
  })

  it('placement 給了兩次時看第一個', () => {
    expect(legacyAdminRedirect('/dashboard/admin/affairs', { placement: ['rules', 'resource'] })).toBe('/dashboard/admin/affairs/rules')
  })

  it('還留在公告頁的篩選不轉：榮譽（①做完榮譽榜才轉）、公告、逾期、全部、沒帶、不認得的值', () => {
    for (const placement of ['honor', 'news', 'overdue', 'all', 'nope', undefined]) {
      expect(legacyAdminRedirect('/dashboard/admin/affairs', { placement, cohort: '115' })).toBeNull()
    }
  })

  it('不是舊網址就不轉（首頁設定、同意書、帳號 ?status= 都還沒輪到）', () => {
    expect(legacyAdminRedirect('/dashboard/admin/home-settings')).toBeNull()
    expect(legacyAdminRedirect('/dashboard/admin/signoff')).toBeNull()
    expect(legacyAdminRedirect('/dashboard/admin/accounts', { status: 'pending' })).toBeNull()
    expect(legacyAdminRedirect('/dashboard/admin/affairs/resources', { placement: 'rules' })).toBeNull()
  })
})
