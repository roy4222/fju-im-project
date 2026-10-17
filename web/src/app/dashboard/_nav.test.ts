import { describe, expect, it } from 'vitest'
import { ADMIN_NAV, NAV_ICON_NAMES, STUDENT_NAV, TEACHER_NAV, isNavActive, navTitle, type NavItem } from './_nav'

const LISTS = { ADMIN_NAV, TEACHER_NAV, STUDENT_NAV }
/** 已經換成新側欄的清單（各角色切換票把自己加進來）：它們照設計方案 §3.1 會有 `activeFor`。 */
const SWITCHED: readonly string[] = ['TEACHER_NAV']

describe('三份側欄清單（SH-1a）', () => {
  for (const [name, items] of Object.entries(LISTS)) {
    it(`${name} 每項都有合法的圖示名字`, () => {
      for (const item of items) expect(NAV_ICON_NAMES).toContain(item.icon)
    })

    it(`${name} 同一組的項目排在一起（分段顯示時組名不重複）`, () => {
      const runs = items.map((item) => item.group).filter((g, i, all) => i === 0 || g !== all[i - 1])
      expect(new Set(runs).size).toBe(runs.length)
    })

    it.skipIf(SWITCHED.includes(name))(`${name} 還沒有 activeFor（各角色切換票才加）`, () => {
      expect(items.filter((item) => item.activeFor !== undefined)).toEqual([])
    })
  }
})

describe('isNavActive', () => {
  const item: NavItem = { href: '/dashboard/admin/grading', label: '成績', icon: 'grading', activeFor: ['/dashboard/admin/signoff'] }

  it('href 等於本頁時亮', () => {
    expect(isNavActive(item, '/dashboard/admin/grading')).toBe(true)
  })

  it('本頁在 activeFor 裡時亮', () => {
    expect(isNavActive(item, '/dashboard/admin/signoff')).toBe(true)
  })

  it('其他頁不亮（不做前綴比對）', () => {
    expect(isNavActive(item, '/dashboard/admin/grading/rules')).toBe(false)
    expect(isNavActive({ href: '/dashboard/admin', label: '首頁', icon: 'home' }, '/dashboard/admin/grading')).toBe(false)
  })
})

describe('navTitle', () => {
  it('亮著那一項的名字', () => {
    expect(navTitle(ADMIN_NAV, '/dashboard/admin/cohorts', '系辦')).toBe('屆別')
  })

  it('沒有命中時回角色名', () => {
    expect(navTitle(STUDENT_NAV, '/dashboard/student/grading', '學生')).toBe('學生')
  })

  it('activeFor 命中也算', () => {
    const items: NavItem[] = [{ href: '/dashboard/teacher/affairs', label: '作業區', icon: 'affairs', activeFor: ['/dashboard/teacher/signoff'] }]
    expect(navTitle(items, '/dashboard/teacher/signoff', '老師')).toBe('作業區')
  })
})
