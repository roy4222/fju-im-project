import { describe, expect, it, test, vi } from 'vitest'
import type { AccountSummary, ResolvedActor } from '@/application/accounts'
import type { AdminAssignmentView, AdminGradingBoard, Gradebook } from '@/application/grading'
import type { CohortGroupingOverview } from '@/application/groups'
import type { ItemListRow } from '@/application/items'
import type { AdminSignoffBoard, SignoffPurpose, SignoffState } from '@/application/signoff'
import type { ItemRoster } from '@/application/submissions'
import { adminTodoCards, heroLine, INTAKE_LIMIT, loadAdminHome, NEWS_LIMIT, type AdminHome, type AdminHomePorts } from './home-data'

// 系辦首頁的資料載入（AD-02）：AC-AD-04 的 port 計數（接線），AC-AD-01／02 的待辦卡、AC-AD-03 的評分還差。
// 測資只填頁面用得到的欄位，其餘用型別斷言帶過。

const NOW = new Date('2026-10-16T10:00:00+08:00')
const DAY = 86_400_000
const ctx = { cohort: { id: 'c43' } as never, businessNow: NOW }
const noCohort = { cohort: null, businessNow: NOW }
const actor = { kind: 'authenticated', userId: 'u-admin', roles: ['admin'], status: 'active' } as unknown as ResolvedActor

function ok<R>(receipt: R) {
  return { ok: true as const, receipt: { ...receipt, requestId: 'r', serverTime: NOW.toISOString() } }
}

function summary(over: Partial<AccountSummary> = {}): AccountSummary {
  return { pendingApplications: 0, pending: 0, active: 0, disabled: 0, activeStudents: 0, orphans: 0, ...over }
}

function item(id: string, over: Partial<ItemListRow> = {}): ItemListRow {
  return { id, placement: 'submission', title: id, status: 'published', receiverUnit: 'individual', updatedAt: NOW, ...over } as ItemListRow
}

type Receiver = { id: string; submitted?: boolean }
function roster(itemId: string, unit: 'individual' | 'group', dueAt: Date, receivers: readonly Receiver[]): ItemRoster {
  return {
    item: { itemId, title: itemId, receiverUnit: unit, opensAt: new Date(NOW.getTime() - 30 * DAY), dueAt },
    entries: receivers.map((r) => ({
      receiverKind: unit === 'group' ? 'group' : 'user',
      receiverId: r.id,
      eligibleTo: null,
      exempt: false,
      hasDraft: false,
      latestVersionNo: r.submitted ? 1 : null,
      reopenUntil: null,
    })),
  } as unknown as ItemRoster
}

/** 每組人數；前兩組是產學組，第一組還沒有指導老師。 */
function overview(sizes: readonly number[], ungrouped = 0): CohortGroupingOverview {
  return {
    groups: sizes.map((size, i) => ({
      id: `g${i}`,
      groupType: i < 2 ? 'industry' : 'general',
      advisor: i === 0 ? null : { userId: 't' },
      members: Array.from({ length: size }, (_, m) => ({ userId: `s${i}-${m}` })),
    })),
    openProposals: [],
    closedProposals: [],
    ungrouped: Array.from({ length: ungrouped }, (_, i) => ({ userId: `u${i}` })),
  } as unknown as CohortGroupingOverview
}

let seq = 0
function assignment(groupId: string, teacher: string, state: AdminAssignmentView['state']): AdminAssignmentView {
  seq += 1
  return { id: `a${seq}`, groupId, stageKey: 'mid', teacherUserId: teacher, teacherName: teacher, teacherInactive: false, state } as AdminAssignmentView
}

function board(assignments: readonly AdminAssignmentView[]): AdminGradingBoard {
  return {
    current: { stages: [{ key: 'mid' }] },
    groups: ['G01', 'G02', 'G03', 'G04', 'G05'].map((id) => ({ id, code: id, advisorName: null })),
    assignments,
  } as unknown as AdminGradingBoard
}

function signoffBoard(states: readonly (Partial<Record<SignoffPurpose, SignoffState>> | null)[]): AdminSignoffBoard {
  return {
    groups: states.map((s, i) => ({
      groupId: `g${i}`,
      groupCode: `G0${i + 1}`,
      packages: { result_confirmation: s?.result_confirmation ? { state: s.result_confirmation } : null, final_document: s?.final_document ? { state: s.final_document } : null },
    })),
  } as unknown as AdminSignoffBoard
}

type Fixture = {
  summary?: AccountSummary
  items?: readonly ItemListRow[]
  rosters?: readonly ItemRoster[]
  overview?: CohortGroupingOverview
  board?: AdminGradingBoard
  signoff?: AdminSignoffBoard
  pendingReviews?: Gradebook['pendingReviews']
}

/** 計數假 port：每個方法都是 vi.fn，回固定測資。 */
function fakePorts(f: Fixture = {}) {
  const rosters = new Map((f.rosters ?? []).map((r) => [r.item.itemId, r]))
  const ports = {
    accounts: { summary: vi.fn(async () => ok(f.summary ?? summary())) },
    groups: { overview: vi.fn(async () => f.overview ?? overview([])) },
    grading: { adminBoard: vi.fn(async () => ok(f.board ?? board([]))) },
    gradebook: { gradebook: vi.fn(async () => ok({ version: null, groups: [], pendingReviews: f.pendingReviews ?? [] })) },
    signoff: { adminBoard: vi.fn(async () => ok(f.signoff ?? signoffBoard([]))) },
    items: { list: vi.fn(async () => [...(f.items ?? [])]) },
    roster: { roster: vi.fn(async (_actor: ResolvedActor, itemId: string) => rosters.get(itemId) ?? roster(itemId, 'individual', NOW, [])) },
  }
  return ports as typeof ports & AdminHomePorts
}

describe('AC-AD-04 首頁 port 呼叫數（接線）', () => {
  for (const n of [1, 8, 80]) {
    it(`${n} 份發布中作業：summary、overview、評分、成績表、同意書、作業清單各 1 次；沒有 storageTile`, async () => {
      const items = Array.from({ length: n }, (_, i) => item(`i${i}`))
      const ports = fakePorts({ items })
      await loadAdminHome(ports, actor, ctx)

      expect(ports.accounts.summary).toHaveBeenCalledTimes(1)
      expect(ports.accounts.summary).toHaveBeenCalledWith(actor)
      expect(ports.groups.overview).toHaveBeenCalledTimes(1)
      // 共用 SH-P4：首頁不讀分組歷程。
      expect(ports.groups.overview).toHaveBeenCalledWith('c43', { history: false })
      expect(ports.grading.adminBoard).toHaveBeenCalledTimes(1)
      expect(ports.gradebook.gradebook).toHaveBeenCalledTimes(1)
      expect(ports.gradebook.gradebook).toHaveBeenCalledWith(actor, 'c43')
      expect(ports.signoff.adminBoard).toHaveBeenCalledTimes(1)
      expect(ports.items.list).toHaveBeenCalledTimes(1)
      // 主機儲存不在首頁的 port 裡（只在開發者後台看）：型別上就沒有 ops，所以 storageTile 一定是 0 次。
      expect(Object.keys(ports).sort()).toEqual(['accounts', 'gradebook', 'grading', 'groups', 'items', 'roster', 'signoff'])
    })
  }

  // AD-19 的 `completionFacts()` 合併後由 AD-13 打開：改成一次聚合讀取，不再逐份讀名單。
  test.todo('1／8／80 份發布中作業：roster() 都 0 次')
  test.todo('1／8／80 份發布中作業：completionFacts() 都 1 次，逾期人數與 overdueReceiverIds 對同一組 facts 的結果相同')

  it('沒有屆別：只讀帳號統計，其餘不讀', async () => {
    const ports = fakePorts()
    const home = await loadAdminHome(ports, actor, noCohort)
    expect(ports.accounts.summary).toHaveBeenCalledTimes(1)
    for (const fn of [ports.groups.overview, ports.grading.adminBoard, ports.gradebook.gradebook, ports.signoff.adminBoard, ports.items.list, ports.roster.roster]) {
      expect(fn).not.toHaveBeenCalled()
    }
    expect(home.published).toBe(0)
    expect(heroLine(home, false)).toBe('')
  })
})

// AC-AD-01 的情境：3 位待審、1 份個人作業 3 人逾期＋1 份整組作業 1 組逾期（另一份還沒截止）、2 位老師還差 7 份、2 份同意書等老師。
function ac01(): Fixture {
  const people = [{ id: 's1' }, { id: 's2' }, { id: 's3' }, { id: 's4', submitted: true }]
  return {
    summary: summary({ pendingApplications: 3, activeStudents: 58 }),
    items: [item('個人心得'), item('期中報告', { receiverUnit: 'group' }), item('期末報告', { receiverUnit: 'group' }), item('公告一', { placement: 'news' })],
    rosters: [
      roster('個人心得', 'individual', new Date(NOW.getTime() - DAY), people),
      roster('期中報告', 'group', new Date(NOW.getTime() - 2 * DAY), [{ id: 'G01' }, { id: 'G02', submitted: true }]),
      roster('期末報告', 'group', new Date(NOW.getTime() + 20 * DAY), [{ id: 'G01' }, { id: 'G02' }]),
    ],
    // 12 組共 58 人（10 組 5 人、2 組 4 人）、3 位未分組。
    overview: overview([...Array(10).fill(5), 4, 4], 3),
    board: board([
      // 王老師 5 份送出 1 份（還差 4）；李老師 4 份送出 1 份（還差 3）；陳老師 2 份全送出。
      assignment('G01', '王老師', 'counted'),
      ...['G02', 'G03', 'G04', 'G05'].map((g) => assignment(g, '王老師', 'draft')),
      assignment('G01', '李老師', 'counted'),
      ...['G02', 'G03', 'G04'].map((g) => assignment(g, '李老師', 'empty')),
      assignment('G01', '陳老師', 'counted'),
      assignment('G02', '陳老師', 'counted'),
    ]),
    signoff: signoffBoard([{ result_confirmation: 'teacher_pending' }, { result_confirmation: 'teacher_pending', final_document: 'collecting' }, { result_confirmation: 'complete' }]),
  }
}

describe('AC-AD-01 首頁只有一組待辦卡', () => {
  it('四張卡依序：待審帳號 3、逾期未繳 4（欠繳 3 人、1 組・發布中 3 個作業）、評分還差 7 份（2 位老師未完成）、等老師同意 2', async () => {
    const home = await loadAdminHome(fakePorts(ac01()), actor, ctx)
    const cards = adminTodoCards(home)
    expect(cards.map((c) => c.title)).toEqual(['待審帳號 3', '逾期未繳 4', '評分還差 7 份', '等老師同意 2'])
    expect(cards[1]!.meta).toBe('欠繳 3 人、1 組・發布中 3 個作業')
    expect(cards[2]!.meta).toBe('2 位老師未完成')
    expect(cards[3]!.meta).toBe('學生已全部同意')
    expect(cards.map((c) => c.pill?.label)).toEqual(['待處理', '待處理', '待處理', '待處理'])
    expect(cards.map((c) => c.tone)).toEqual(['alert', 'overdue', 'open', 'violet'])
    // 頁面上不再有「今天」「件待處理」「主機儲存」「尚未完成評分的老師」「繳交項目」。
    const text = JSON.stringify(cards) + heroLine(home, true)
    for (const gone of ['今天', '件待處理', '主機儲存', '尚未完成評分的老師', '繳交項目']) expect(text).not.toContain(gone)
  })

  it('橫幅第二行只講分組：「本屆 12 組、58 位學生已分組、3 位未分組。」', async () => {
    const home = await loadAdminHome(fakePorts(ac01()), actor, ctx)
    expect(heroLine(home, true)).toBe('本屆 12 組、58 位學生已分組、3 位未分組。')
  })

  it('連結：待審→帳號頁待審篩選；逾期→欠繳最多那份作業的名單頁（Q114 維持現行）；評分→成績頁；同意書→等老師最多的用途', async () => {
    const home = await loadAdminHome(fakePorts(ac01()), actor, ctx)
    expect(adminTodoCards(home).map((c) => c.href)).toEqual([
      '/dashboard/admin/accounts?status=pending',
      '/dashboard/admin/affairs/個人心得',
      '/dashboard/admin/grading',
      '/dashboard/admin/signoff?purpose=result_confirmation',
    ])
  })

  it('逾期人數跟 overdueReceiverIds 同一口徑：同一位在兩份作業都逾期只算一次', async () => {
    const f: Fixture = {
      items: [item('a'), item('b')],
      rosters: [roster('a', 'individual', new Date(NOW.getTime() - DAY), [{ id: 's1' }]), roster('b', 'individual', new Date(NOW.getTime() - DAY), [{ id: 's1' }, { id: 's2' }])],
    }
    const home = await loadAdminHome(fakePorts(f), actor, ctx)
    expect(home.overdue).toMatchObject({ total: 2, people: 2, groups: 0, worst: { id: 'b' } })
    expect(adminTodoCards(home)[1]!.meta).toBe('欠繳 2 人・發布中 2 個作業')
  })

  it('完成率列表最多列 INTAKE_LIMIT 份，逾期仍掃全部；公告只列 NEWS_LIMIT 則', async () => {
    const many = Array.from({ length: INTAKE_LIMIT + 2 }, (_, i) => item(`i${i}`))
    const news = Array.from({ length: NEWS_LIMIT + 2 }, (_, i) => item(`n${i}`, { placement: 'news' }))
    const last = `i${INTAKE_LIMIT + 1}`
    const home = await loadAdminHome(
      fakePorts({ items: [...many, ...news], rosters: [roster(last, 'individual', new Date(NOW.getTime() - DAY), [{ id: 's9' }])] }),
      actor,
      ctx,
    )
    expect(home.intake).toHaveLength(INTAKE_LIMIT)
    expect(home.published).toBe(INTAKE_LIMIT + 2)
    expect(home.overdue.worst).toEqual({ id: last, title: last })
    expect(home.news).toHaveLength(NEWS_LIMIT)
    expect(home.newsCount).toBe(NEWS_LIMIT + 2)
  })
})

describe('AC-AD-02 待辦卡數字為 0 也在', () => {
  it('全部為 0：四張卡都在、數字 0、膠囊寫「沒有待辦」', async () => {
    const home = await loadAdminHome(fakePorts(), actor, ctx)
    const cards = adminTodoCards(home)
    expect(cards.map((c) => c.title)).toEqual(['待審帳號 0', '逾期未繳 0', '評分還差 0 份', '等老師同意 0'])
    expect(cards.map((c) => c.pill?.label)).toEqual(['沒有待辦', '沒有待辦', '沒有待辦', '沒有待辦'])
    expect(cards.map((c) => c.href)).toEqual([
      '/dashboard/admin/accounts?status=pending',
      '/dashboard/admin/affairs',
      '/dashboard/admin/grading',
      '/dashboard/admin/signoff',
    ])
    expect(heroLine(home, true)).toBe('本屆 0 組、0 位學生已分組、0 位未分組。')
  })

  it('讀不到帳號統計：待審卡仍在，寫「—」與原因，不寫「沒有待辦」', async () => {
    const ports = fakePorts()
    ports.accounts.summary.mockResolvedValueOnce({ ok: false, code: 'FORBIDDEN', message: 'x' } as never)
    const cards = adminTodoCards(await loadAdminHome(ports, actor, ctx))
    expect(cards[0]).toMatchObject({ title: '待審帳號 —', meta: '讀不到帳號統計', pill: undefined })
  })
})

describe('AC-AD-03 評分還差＝Σ（分母 − 分子），跟成績頁同一個 teacherProgress', () => {
  it('解散組（不在 adminBoard.groups）上的指派不算', async () => {
    const b = board([assignment('G01', '王老師', 'counted'), assignment('G02', '王老師', 'draft'), assignment('G12', '王老師', 'draft')])
    const home: AdminHome = await loadAdminHome(fakePorts({ board: b }), actor, ctx)
    expect(home.teachers).toEqual([expect.objectContaining({ name: '王老師', assigned: 2, counted: 1 })])
    expect(home.remaining).toBe(1)
    expect(adminTodoCards(home)[2]).toMatchObject({ title: '評分還差 1 份', meta: '1 位老師未完成' })
  })
})

describe('AC-AD-05 成績更正提示的資料', () => {
  it('讀 gradebook 成功結果的 pendingReviews', async () => {
    const pendingReviews = [{ overrideId: 'o1', groupId: 'g1', groupCode: 'G01', originalValue: '80', newValue: '85', reason: '口試補考' }]
    const home = await loadAdminHome(fakePorts({ pendingReviews }), actor, ctx)
    expect(home.pendingReviews).toEqual(pendingReviews)
  })
})
