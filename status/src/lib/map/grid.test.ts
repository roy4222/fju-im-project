// 測試地圖的格子判定（設計方案 §3.9）。資料用字面值，形狀照 summarize-night.sh:657-705。
import { describe, expect, it } from 'vitest'

import type { SummaryItem, SummaryJson, SummaryProblem, SummaryStep, TestMapFile } from '../data/types'
import { buildSections, buildTestMap, stepNumber, worstStatus } from './grid'

const step = (步驟: string, 角色: string, 結果 = '通過', 截圖: string[] = []): SummaryStep => ({
  步驟, 角色, 結果, 看到什麼: `看到 ${步驟}`, 截圖,
})

const problem = (編號: string, 嚴重度: string, 步驟: string): SummaryProblem => ({
  編號, 嚴重度, 一句話: `${編號} 的問題`, 角色: '系辦', 頁面: '/', 步驟, 截圖: '', 已知: '否', 可開票: '是',
})

const item = (id: string, over: Partial<SummaryItem> = {}): SummaryItem => ({
  id, kind: 'story', status: 'ok', resumed: false, dependencyNotMet: false, security: null, report: null,
  parsed: true, summaryLine: null, relay: null, counts: {}, steps: [], problems: [], errors: [], ...over,
})

const summary = (items: SummaryItem[]): SummaryJson => ({
  runId: 'night-20261012-2200', plan: 'full', startedAt: null, finishedAt: null, commitStart: null, commitEnd: null,
  problemColumns: [], items, personas: [],
})

const roles: TestMapFile['roles'] = [
  { key: 'visitor', name: '訪客', aliases: ['訪客', '高中生訪客'] },
  { key: 'student', name: '學生', aliases: ['學生', '組長'] },
  { key: 'teacher', name: '老師', aliases: ['老師'] },
  { key: 'admin', name: '系辦', aliases: ['系辦'] },
]

// AC-S-15 的情境：「最新公告」四種結果、「名單匯入」只指到解析失敗的 story-5。
const testMap: TestMapFile = {
  roles,
  features: [
    {
      key: 'news', name: '最新公告', roles: ['visitor', 'student', 'teacher', 'admin'],
      evidence: [{ item: 'story-1', steps: [1, 2, 3, 4] }], e2e: ['web/e2e/public-pages.spec.ts'],
    },
    {
      key: 'roster', name: '名單匯入', roles: ['student', 'teacher', 'admin'],
      evidence: [{ item: 'story-5', steps: [1, 2, 3] }], e2e: [],
    },
  ],
  sections: [],
}

const night = summary([
  item('story-1', {
    steps: [
      step('1 首頁看公告', '訪客', '通過', ['story-1/screenshots/01-home.png']),
      step('2 點進公告', '高中生訪客'),
      step('3 學生看公告', '學生', '不通過'),
      step('4 系辦發公告', '系辦'),
    ],
    problems: [problem('S1-01', '要修', '4'), problem('S1-02', '建議', '1')],
  }),
  item('story-5', {
    parsed: false,
    errors: ['問題表欄數不對'],
    steps: [step('1 上傳名單', '系辦'), step('2 看預覽', '系辦'), step('3 學生收到帳號', '學生')],
    problems: [],
  }),
])

const cell = (view: ReturnType<typeof buildTestMap>, feature: string, role: string) =>
  view.rows.find((r) => r.feature.key === feature)!.cells.find((c) => c.role === role)!

describe('stepNumber：步驟欄開頭的整數', () => {
  it('取開頭整數，沒有就是 null', () => {
    expect(stepNumber('1 記下測試站版本')).toBe(1)
    expect(stepNumber(' 12、看列表')).toBe(12)
    expect(stepNumber('記下版本')).toBeNull()
  })
})

describe('buildTestMap：角色 × 功能', () => {
  it('AC-S-15「最新公告」：訪客 ✅、學生 ⚠️、老師 ⬜、系辦 ⚠️（同步驟有要修）', () => {
    const view = buildTestMap(testMap, night)
    expect(cell(view, 'news', 'visitor').status).toBe('ok')
    expect(cell(view, 'news', 'visitor').steps.map((s) => s.stepNo)).toEqual([1, 2])
    expect(cell(view, 'news', 'student').status).toBe('warn')
    expect(cell(view, 'news', 'teacher').status).toBe('untested')
    expect(cell(view, 'news', 'admin').status).toBe('warn')
    expect(cell(view, 'news', 'admin').steps[0]!.problems.map((p) => p.編號)).toEqual(['S1-01'])
  })

  it('「建議」不算有問題，但抽屜照列', () => {
    const view = buildTestMap(testMap, night)
    const visitor = cell(view, 'news', 'visitor')
    expect(visitor.status).toBe('ok')
    expect(visitor.steps[0]!.problems.map((p) => p.編號)).toEqual(['S1-02'])
  })

  it('不在功能角色裡的格是「不適用」', () => {
    expect(cell(buildTestMap(testMap, night), 'roster', 'visitor').status).toBe('na')
  })

  it('AC-S-15「名單匯入」：item 解析失敗→有步驟的格全是報告解析失敗，空的 problems 不算沒問題', () => {
    const view = buildTestMap(testMap, night)
    for (const role of ['student', 'admin']) {
      const c = cell(view, 'roster', role)
      expect(c.status).toBe('parse-failed')
      expect(c.parseFailures).toEqual([{ item: 'story-5', errors: ['問題表欄數不對'] }])
    }
    expect(cell(view, 'roster', 'teacher').status).toBe('untested')
  })

  it('parsed 是 true 但 errors 非空，一樣算解析失敗', () => {
    const s = summary([item('story-5', { errors: ['步驟表少一欄'], steps: [step('1 上傳名單', '系辦')] })])
    expect(cell(buildTestMap(testMap, s), 'roster', 'admin').status).toBe('parse-failed')
  })

  it('parsed 不是 true 且沒有 errors，也算解析失敗並寫出原因', () => {
    const bad = { ...item('story-5', { steps: [step('1 上傳名單', '系辦')] }), parsed: null } as unknown as SummaryItem
    const c = cell(buildTestMap(testMap, summary([bad])), 'roster', 'admin')
    expect(c.status).toBe('parse-failed')
    expect(c.parseFailures[0]!.errors).toEqual(['parsed 不是 true'])
  })

  it('一格同時有解析失敗與正常的 item：整格算解析失敗', () => {
    const map: TestMapFile = {
      ...testMap,
      features: [{
        key: 'mix', name: '混合', roles: ['admin'],
        evidence: [{ item: 'story-1', steps: [4] }, { item: 'story-5', steps: [1] }], e2e: [],
      }],
    }
    const ok1 = summary([item('story-1', { steps: [step('4 系辦發公告', '系辦')] }), night.items[1]!])
    expect(cell(buildTestMap(map, ok1), 'mix', 'admin').status).toBe('parse-failed')
  })

  it('item 那夜沒跑或前置沒過（沒有步驟）→ 沒測到', () => {
    const s = summary([item('story-1', { dependencyNotMet: true })])
    expect(cell(buildTestMap(testMap, s), 'news', 'visitor').status).toBe('untested')
  })

  it('「擋上線」也算有問題', () => {
    const s = summary([item('story-1', { steps: [step('1 首頁', '訪客')], problems: [problem('S1-09', '擋上線', '1')] })])
    expect(cell(buildTestMap(testMap, s), 'news', 'visitor').status).toBe('warn')
  })

  it('做不到、略過都不是「通過」→ 有狀況', () => {
    const s = summary([item('story-1', { steps: [step('1 首頁', '訪客', '做不到（環境：測試站沒開）')] })])
    expect(cell(buildTestMap(testMap, s), 'news', 'visitor').status).toBe('warn')
  })

  it('角色字串完全相等才算；對不到的列進「認不得的角色」', () => {
    const s = summary([item('story-1', { steps: [step('1 首頁', '訪客 '), step('2 公告', '神秘人')] })])
    const view = buildTestMap(testMap, s)
    expect(cell(view, 'news', 'visitor').status).toBe('untested')
    expect(view.unknownRoles).toEqual(['訪客 ', '神秘人'])
  })

  it('地圖過期：evidence 指到該夜不存在的步驟或 item，頁頂列出（不重複）', () => {
    const map: TestMapFile = {
      ...testMap,
      features: [
        ...testMap.features,
        { key: 'x', name: 'X', roles: ['admin'], evidence: [{ item: 'story-2', steps: [99] }, { item: 'story-1', steps: [99] }], e2e: [] },
        { key: 'y', name: 'Y', roles: ['admin'], evidence: [{ item: 'story-2', steps: [99] }], e2e: [] },
      ],
    }
    expect(buildTestMap(map, night).stale).toEqual([
      { item: 'story-2', step: 99 },
      { item: 'story-1', step: 99 },
    ])
  })
})

describe('worstStatus', () => {
  it('解析失敗 > 有狀況 > 沒測到 > 有點過；不適用不算；全不適用是 na', () => {
    expect(worstStatus(['ok', 'untested'])).toBe('untested')
    expect(worstStatus(['ok', 'warn', 'untested'])).toBe('warn')
    expect(worstStatus(['warn', 'parse-failed'])).toBe('parse-failed')
    expect(worstStatus(['na', 'ok'])).toBe('ok')
    expect(worstStatus(['na'])).toBe('na')
  })
})

describe('buildSections：前台每一區', () => {
  const map: TestMapFile = {
    ...testMap,
    sections: [
      { key: 'home-news', page: '/', name: '首頁・最新公告', frontFeature: 'news', adminPage: '/dashboard/admin/affairs', adminFeature: 'news', crud: { create: '有', edit: '有', delete: '只能下架' } },
      { key: 'home-contact', page: '/', name: '首頁・系辦聯絡卡', frontFeature: 'news', adminPage: null, adminFeature: null, crud: null, exception: 'Q18：用程式改，不做後台' },
      { key: 'orphan', page: '/x', name: '孤兒區', frontFeature: 'nope', adminPage: null, adminFeature: null, crud: null },
    ],
  }

  it('前台測過＝各角色格最差；後台測過＝adminFeature 的系辦格；連到測試站', () => {
    const rows = buildSections(map, buildTestMap(map, night))
    expect(rows[0]).toMatchObject({ front: 'warn', admin: 'warn', missingAdmin: false, adminUrl: 'https://test.fju.roy422.dev/dashboard/admin/affairs' })
  })

  it('AC-S-17：adminPage 是 null 且沒有 exception → 標紅；有 exception 不標紅', () => {
    const rows = buildSections(map, buildTestMap(map, night))
    expect(rows[1]).toMatchObject({ missingAdmin: false, adminUrl: null, admin: null })
    expect(rows[2]).toMatchObject({ missingAdmin: true, front: null })
  })

  it('沒有 summary（最新一夜沒有彙整結果）：測過欄都是 null，紅列照判', () => {
    const rows = buildSections(map, null)
    expect(rows.map((r) => [r.front, r.admin, r.missingAdmin])).toEqual([[null, null, false], [null, null, false], [null, null, true]])
  })
})
