import { describe, expect, it } from 'vitest'
import { ADMIN_NAV, PROTECTED_ROUTES, isNavActive } from '@/app/dashboard/_nav'
import { ACCOUNT_TABS, AFFAIRS_TABS, GRADING_TABS, GROUP_TABS, SETTINGS_TABS } from './_tabs.consts'

// 分頁列常數（C 階段規格② 設計方案 §2.2）：順序、標籤、路由照總表；每個分頁都受保護、都讓所屬側欄那一項亮。
const GROUPS = [
  {
    name: 'AFFAIRS_TABS',
    tabs: AFFAIRS_TABS,
    nav: '公告與作業',
    expected: [
      ['公告', '/dashboard/admin/affairs'],
      ['作業', '/dashboard/admin/affairs/assignments'],
      ['資源下載', '/dashboard/admin/affairs/resources'],
      ['專題規則', '/dashboard/admin/affairs/rules'],
      ['成果展示', '/dashboard/admin/showcase'],
      ['檔案', '/dashboard/admin/files'],
    ],
  },
  {
    name: 'GROUP_TABS',
    tabs: GROUP_TABS,
    nav: '分組',
    expected: [
      ['全部組別', '/dashboard/admin/groups'],
      ['未分組學生', '/dashboard/admin/groups/unassigned'],
      ['產學合作', '/dashboard/admin/industry'],
    ],
  },
  {
    name: 'GRADING_TABS',
    tabs: GRADING_TABS,
    nav: '成績',
    expected: [
      ['成績表', '/dashboard/admin/grading'],
      ['評分規則', '/dashboard/admin/grading/rules'],
      ['評分老師', '/dashboard/admin/grading/teachers'],
      ['結算', '/dashboard/admin/grading/settle'],
    ],
  },
  {
    name: 'ACCOUNT_TABS',
    tabs: ACCOUNT_TABS,
    nav: '帳號',
    expected: [
      ['全部帳號', '/dashboard/admin/accounts'],
      ['待審核', '/dashboard/admin/accounts/pending'],
      ['已停用', '/dashboard/admin/accounts/disabled'],
      ['名單匯入', '/dashboard/admin/accounts/roster'],
    ],
  },
  {
    name: 'SETTINGS_TABS',
    tabs: SETTINGS_TABS,
    nav: '設定',
    expected: [
      ['屆別', '/dashboard/admin/cohorts'],
      ['專題時程', '/dashboard/admin/timeline'],
      ['操作紀錄', '/dashboard/admin/audit'],
    ],
  },
] as const

describe('後台分頁列常數（C2-01）', () => {
  for (const { name, tabs, nav, expected } of GROUPS) {
    it(`${name}：標籤與路由照總表順序`, () => {
      expect(tabs.map((t) => [t.label, t.href])).toEqual(expected)
    })

    it(`${name}：每個分頁都在受保護路由清單、只給系辦`, () => {
      for (const tab of tabs) expect(PROTECTED_ROUTES).toContainEqual({ path: tab.href, role: 'admin' })
    })

    it(`${name}：每個分頁都讓側欄「${nav}」亮，而且只亮這一項`, () => {
      for (const tab of tabs) {
        expect(ADMIN_NAV.filter((item) => isNavActive(item, tab.href)).map((item) => item.label)).toEqual([nav])
      }
    })
  }

  it('首頁設定、同意書、測試用時間不在任何分頁列上', () => {
    const all = GROUPS.flatMap((g) => g.tabs.map((t) => t.href))
    for (const path of ['/dashboard/admin/home-settings', '/dashboard/admin/signoff', '/dashboard/admin/clock']) {
      expect(all).not.toContain(path)
    }
  })
})
