// AC-S-11：驗收索引以 run.json 為主、summary.json 為輔；latestFullAttempt 不回退。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildAcceptanceIndex, parseTime } from './lib/acceptance.mjs'
import { writeRun } from './testing/fakes.mjs'

const FULL = [
  'security-static', 'story-1', 'story-2', 'story-3', 'story-4', 'story-5', 'story-6',
  'ux-admin-midterm', 'ux-leader', 'ux-member', 'ux-ungrouped', 'ux-grader', 'ux-advisor',
  'ux-freshman', 'ux-visitor-highschool', 'ux-visitor-industry', 'ux-admin-newbie', 'r1-login-limit',
]
const okItems = () => FULL.map((id) => ({ id, kind: 'codex', status: 'ok' }))
const summaryOf = (runId) => ({ runId, plan: 'full', items: FULL.map((id) => ({ id, parsed: true })), personas: [] })

let inbox
beforeEach(() => {
  inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'fju-inbox-'))
})
afterEach(() => fs.rmSync(inbox, { recursive: true, force: true }))

describe('AC-S-11 五夜', () => {
  it('runs 五筆新到舊；latestFullAttempt 指到最新的 full 嘗試（只跑 story-1 那夜），不回退到完整那夜', () => {
    // (1) 最新：--only story-1
    writeRun(inbox, 'night-20261012-2200', {
      startedAt: '2026-10-12T22:00:00+0800',
      items: [{ id: 'story-1', kind: 'codex', status: 'ok' }],
      summary: summaryOf('night-20261012-2200'),
    })
    // (2) 18 項齊但 story-3 是 env
    writeRun(inbox, 'night-20261011-2200', {
      startedAt: '2026-10-11T22:00:00+0800',
      items: okItems().map((i) => (i.id === 'story-3' ? { ...i, status: 'env' } : i)),
      summary: summaryOf('night-20261011-2200'),
    })
    // (3) 有 run.json 沒有 summary.json
    writeRun(inbox, 'night-20261010-2200', { startedAt: '2026-10-10T22:00:00+0800', items: okItems() })
    // (4) 完整正常
    writeRun(inbox, 'night-20261009-2200', {
      startedAt: '2026-10-09T22:00:00+0800',
      items: okItems(),
      summary: summaryOf('night-20261009-2200'),
    })
    // (5) quick
    writeRun(inbox, 'quick-20261012-0900', {
      plan: 'quick',
      startedAt: '2026-10-12T09:00:00+0800',
      items: [{ id: 'story-1', kind: 'codex', status: 'ok' }],
      summary: { ...summaryOf('quick-20261012-0900'), plan: 'quick' },
    })

    const idx = buildAcceptanceIndex(inbox, { requiredItems: FULL, sourceSha: 'f'.repeat(40) })

    expect(idx.runs.map((r) => r.runId)).toEqual([
      'night-20261012-2200',
      'quick-20261012-0900',
      'night-20261011-2200',
      'night-20261010-2200',
      'night-20261009-2200',
    ])
    for (const r of idx.runs) {
      expect(Array.isArray(r.items)).toBe(true)
      expect(typeof r.hasSummary).toBe('boolean')
      expect(typeof r.summaryValid).toBe('boolean')
    }
    expect(idx.latestFullAttempt).toBe('night-20261012-2200')
    expect(idx.runs[0].items).toEqual([{ id: 'story-1', status: 'ok' }])

    const byId = Object.fromEntries(idx.runs.map((r) => [r.runId, r]))
    expect(byId['night-20261011-2200'].items.find((i) => i.id === 'story-3').status).toBe('env')
    expect(byId['night-20261010-2200']).toMatchObject({ hasSummary: false, summaryValid: false, invalidReason: null })
    expect(byId['night-20261009-2200']).toMatchObject({ hasSummary: true, summaryValid: true, plan: 'full' })
    expect(byId['night-20261009-2200'].items).toHaveLength(18)
    expect(idx.requiredItems).toEqual(FULL)
    expect(idx.requiredItemsSourceSha).toBe('f'.repeat(40))
  })

  it('最新 full 沒有 summary.json 也照樣是 latestFullAttempt（不回退）', () => {
    writeRun(inbox, 'night-b', { startedAt: '2026-10-12T22:00:00+0800', items: okItems() })
    writeRun(inbox, 'night-a', { startedAt: '2026-10-11T22:00:00+0800', items: okItems(), summary: summaryOf('night-a') })
    const idx = buildAcceptanceIndex(inbox, null)
    expect(idx.latestFullAttempt).toBe('night-b')
    expect(idx.runs[0]).toMatchObject({ runId: 'night-b', hasSummary: false })
    expect(idx.requiredItems).toBeNull()
  })

  it('summary.json 壞掉、runId 對不上：hasSummary true、summaryValid false、寫原因', () => {
    writeRun(inbox, 'night-x', { startedAt: '2026-10-12T22:00:00+0800', items: okItems(), summary: '{壞' })
    writeRun(inbox, 'night-y', { startedAt: '2026-10-11T22:00:00+0800', items: okItems(), summary: summaryOf('別的') })
    const idx = buildAcceptanceIndex(inbox, null)
    expect(idx.runs[0]).toMatchObject({ runId: 'night-x', hasSummary: true, summaryValid: false })
    expect(idx.runs[0].invalidReason).toContain('不是合法的 JSON')
    expect(idx.runs[1].invalidReason).toContain('runId')
  })

  it('沒有 run.json 的目錄不列；run.json 壞掉的列出但標原因、plan 是 null', () => {
    fs.mkdirSync(path.join(inbox, 'stray'))
    fs.mkdirSync(path.join(inbox, 'broken'))
    fs.writeFileSync(path.join(inbox, 'broken', 'run.json'), 'nope')
    const idx = buildAcceptanceIndex(inbox, null)
    expect(idx.runs).toHaveLength(1)
    expect(idx.runs[0]).toMatchObject({ runId: 'broken', plan: null, items: [] })
    expect(idx.latestFullAttempt).toBeNull()
  })

  it('inbox 不存在時是空索引', () => {
    expect(buildAcceptanceIndex(path.join(inbox, 'none'), null)).toMatchObject({ runs: [], latestFullAttempt: null })
  })

  it('時間格式 +0800 解析得出來', () => {
    expect(parseTime('2026-10-12T22:00:00+0800')).toBe(Date.parse('2026-10-12T14:00:00Z'))
  })
})

describe('run.json 欄位分欄驗證（Review 第三輪：不回退）', () => {
  const runJson = (runId, extra) =>
    JSON.stringify({ runId, plan: 'full', startedAt: '2026-10-12T22:00:00+0800', finishedAt: '2026-10-12T23:00:00+0800', commitStart: 'abc12345', commitEnd: 'abc12345', items: [{ id: 'story-1', status: 'ok' }], ...extra })
  const writeRaw = (runId, text) => {
    fs.mkdirSync(path.join(inbox, runId), { recursive: true })
    fs.writeFileSync(path.join(inbox, runId, 'run.json'), text)
  }

  it('commitEnd 塞了 URL 編碼的連線字串：只有那欄變 null、標原因；plan 與時間保留，仍是 latestFullAttempt', () => {
    writeRaw('night-z', runJson('night-z', { commitEnd: 'postgresql://db/fju?user=app&%70assword=FAKEPASS123' }))
    const idx = buildAcceptanceIndex(inbox, null)
    expect(idx.runs[0]).toMatchObject({ runId: 'night-z', plan: 'full', startedAt: '2026-10-12T22:00:00+0800', commitStart: 'abc12345', commitEnd: null, items: [{ id: 'story-1', status: 'ok' }] })
    expect(idx.runs[0].invalidReason).toContain('commitEnd')
    expect(idx.runs[0].invalidReason).not.toContain('FAKEPASS')
    expect(JSON.stringify(idx)).not.toContain('FAKEPASS')
    expect(idx.latestFullAttempt).toBe('night-z')
  })

  it('舊的 full 完整全綠、最新的 full 有壞欄位：latestFullAttempt 仍是最新那夜，不回退', () => {
    writeRun(inbox, 'night-old', { startedAt: '2026-10-11T22:00:00+0800', items: okItems(), summary: summaryOf('night-old') })
    writeRaw('night-new', runJson('night-new', { startedAt: '2026-10-12T22:00:00+0800', commitStart: 'postgres://a:FAKEPASS124@h/d', items: [{ id: 'story-1', status: 'ok' }, { id: 'story-2', status: 'bad status: FAKEPASS125' }] }))
    const idx = buildAcceptanceIndex(inbox, null)
    expect(idx.runs.map((r) => r.runId)).toEqual(['night-new', 'night-old'])
    expect(idx.latestFullAttempt).toBe('night-new')
    expect(idx.runs[0]).toMatchObject({ plan: 'full', commitStart: null, items: [{ id: 'story-1', status: 'ok' }] })
    expect(idx.runs[0].invalidReason).toMatch(/commitStart/)
    expect(idx.runs[0].invalidReason).toMatch(/items\[1\]/)
    expect(JSON.stringify(idx)).not.toContain('FAKEPASS')
  })

  it('還沒結束的那夜：finishedAt、commitEnd 是空字串（acceptance-night.sh 跑到一半的 write_run_json）→ 當 null、不算壞', () => {
    writeRaw('night-running', runJson('night-running', { finishedAt: '', commitEnd: '', items: [{ id: 'story-1', status: 'ok' }, { id: 'story-2', status: 'running', startedAt: '2026-10-12T22:30:00+0800', finishedAt: '' }] }))
    const idx = buildAcceptanceIndex(inbox, null)
    expect(idx.runs[0]).toMatchObject({ runId: 'night-running', plan: 'full', finishedAt: null, commitEnd: null, invalidReason: null })
    expect(idx.runs[0].items).toEqual([{ id: 'story-1', status: 'ok' }, { id: 'story-2', status: 'running' }])
    expect(idx.latestFullAttempt).toBe('night-running')
  })

  it('startedAt 壞掉：那欄 null、排到最後，但 plan 保留', () => {
    writeRun(inbox, 'night-ok', { startedAt: '2026-10-11T22:00:00+0800', items: okItems() })
    writeRaw('night-bad-time', runJson('night-bad-time', { startedAt: 'yesterday password=FAKEPASS126' }))
    const idx = buildAcceptanceIndex(inbox, null)
    expect(idx.runs.map((r) => r.runId)).toEqual(['night-ok', 'night-bad-time'])
    expect(idx.runs[1]).toMatchObject({ plan: 'full', startedAt: null })
    expect(idx.runs[1].invalidReason).toContain('startedAt')
    expect(JSON.stringify(idx)).not.toContain('FAKEPASS')
  })
})

describe('run.json 容器與型別錯誤（Review 第四輪）', () => {
  const base = { plan: 'full', startedAt: '2026-10-12T22:00:00+0800', finishedAt: '2026-10-12T23:00:00+0800', commitStart: 'abc12345', commitEnd: 'abc12345' }
  const writeRaw = (runId, obj) => {
    fs.mkdirSync(path.join(inbox, runId), { recursive: true })
    fs.writeFileSync(path.join(inbox, runId, 'run.json'), JSON.stringify({ runId, ...obj }))
  }

  it.each([
    ['items:null', null],
    ['items:{}', {}],
    ['items:"x"', 'x'],
    ['沒有 items', undefined],
  ])('最新 full 的 %s：items 用空陣列代替、原因獨立記錄；plan 與時間保留，不回退到舊 full', (_label, items) => {
    writeRun(inbox, 'night-old', { startedAt: '2026-10-11T22:00:00+0800', items: okItems(), summary: summaryOf('night-old') })
    writeRaw('night-new', items === undefined ? base : { ...base, items })
    const idx = buildAcceptanceIndex(inbox, null)
    expect(idx.runs.map((r) => r.runId)).toEqual(['night-new', 'night-old'])
    expect(idx.runs[0]).toMatchObject({ runId: 'night-new', plan: 'full', startedAt: base.startedAt, items: [], hasSummary: false })
    expect(idx.runs[0].invalidReason).toContain('items')
    expect(idx.latestFullAttempt).toBe('night-new')
  })

  it('欄位型別不對（數字、陣列、布林）：那欄 null 並記原因；只有 finishedAt／commitEnd 的空字串算正常', () => {
    writeRaw('night-types', { ...base, plan: 123, commitStart: ['a'], finishedAt: '', commitEnd: '', items: [{ id: 'story-1', status: 'ok' }] })
    const idx = buildAcceptanceIndex(inbox, null)
    expect(idx.runs[0]).toMatchObject({ plan: null, commitStart: null, finishedAt: null, commitEnd: null, startedAt: base.startedAt, items: [{ id: 'story-1', status: 'ok' }] })
    expect(idx.runs[0].invalidReason).toMatch(/plan/)
    expect(idx.runs[0].invalidReason).toMatch(/commitStart/)
    expect(idx.runs[0].invalidReason).not.toMatch(/finishedAt|commitEnd/)
    expect(idx.latestFullAttempt).toBeNull() // plan 壞掉就不能說它是 full
  })

  it('plan、startedAt、commitStart 的空字串不是正常值：記原因', () => {
    writeRaw('night-empty', { ...base, plan: '', startedAt: '', commitStart: '', items: [] })
    const idx = buildAcceptanceIndex(inbox, null)
    expect(idx.runs[0]).toMatchObject({ plan: null, startedAt: null, commitStart: null })
    for (const k of ['plan', 'startedAt', 'commitStart']) expect(idx.runs[0].invalidReason).toContain(k)
  })

  it('壞的 item（不是物件、id 不是字串、status 不是非空字串）剔除並記原因，其餘 item 保留', () => {
    writeRaw('night-items', { ...base, items: [{ id: 'story-1', status: 'ok' }, { id: 5, status: 'ok' }, 'junk', { id: 'story-3', status: 7 }, { id: 'story-4', status: '' }, { id: 'story-5', status: 'env' }] })
    const idx = buildAcceptanceIndex(inbox, null)
    expect(idx.runs[0].items).toEqual([{ id: 'story-1', status: 'ok' }, { id: 'story-5', status: 'env' }])
    for (const i of [1, 2, 3, 4]) expect(idx.runs[0].invalidReason).toContain(`items[${i}]`)
    expect(idx.latestFullAttempt).toBe('night-items')
  })
})
