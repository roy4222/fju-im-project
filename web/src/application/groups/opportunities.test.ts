import { describe, expect, it } from 'vitest'
import type { ResolvedActor } from '@/application/accounts'
import {
  applyRosterFilter,
  buildRosterCsv,
  canManageOpportunity,
  canViewOpportunities,
  describeGroupHistory,
  groupEmailList,
  leaderTypeChangeBlockers,
  normalizeOpportunityInput,
  normalizeRosterExportRequest,
  normalizeRosterFilter,
  opportunitySummary,
  rosterExportRows,
  rosterQueryString,
  type GroupSummary,
  type OpportunityInput,
} from '@/application/groups'

/** 票 20 的純規則：合作案欄位、誰看得到聯絡資訊、組長改類型的條件、組別名單的篩選排序與匯出列。 */

const actor = (userId: string, roles: ('admin' | 'teacher' | 'student')[], extra: Partial<ResolvedActor> = {}): ResolvedActor =>
  ({ kind: 'authenticated', userId, roles, status: 'active', mustChangePassword: false, cohortMemberships: [], ...extra }) as ResolvedActor

const base: OpportunityInput = {
  companyName: ' 輔仁零售 ',
  department: '資訊部',
  content: '內容\r\n第二行',
  requirements: '',
  notes: '',
  notesVisibility: 'internal',
  address: '',
  contactName: '',
  contactPhone: '',
  contactEmail: '',
}

describe('合作案欄位', () => {
  it('去空白、換行統一、選填沒填是 null', () => {
    const result = normalizeOpportunityInput(base)
    expect(result.ok && result.value).toMatchObject({
      companyName: '輔仁零售',
      content: '內容\n第二行',
      requirements: '',
      notes: null,
      contactEmail: null,
    })
  })

  it('必填、Email、電話、備註可見範圍', () => {
    const field = (input: Partial<OpportunityInput>) => {
      const r = normalizeOpportunityInput({ ...base, ...input })
      return r.ok ? null : r.details?.field
    }
    expect(field({ department: '' })).toBe('department')
    expect(field({ content: '   ' })).toBe('content')
    expect(field({ contactEmail: 'a@b' })).toBe('contactEmail')
    expect(field({ contactPhone: '電話' })).toBe('contactPhone')
    expect(field({ contactPhone: '(02) 2905-2000 #123' })).toBeNull()
    expect(field({ notesVisibility: 'public' })).toBe('notesVisibility')
  })

  it('列表摘要：拿掉標籤、壓成一行、超過就截斷', () => {
    expect(opportunitySummary('<p>第一段</p>\n\n<b>第二段</b>')).toBe('第一段 第二段')
    expect(opportunitySummary('字'.repeat(100))).toHaveLength(81)
  })
})

describe('誰看得到', () => {
  it('訪客、待審、必須改密、沒有角色的帳號看不到合作案', () => {
    expect(canViewOpportunities({ kind: 'anonymous' })).toBe(false)
    expect(canViewOpportunities(actor('u', ['student'], { status: 'pending' }))).toBe(false)
    expect(canViewOpportunities(actor('u', ['student'], { mustChangePassword: true }))).toBe(false)
    expect(canViewOpportunities(actor('u', []))).toBe(false)
    expect(canViewOpportunities(actor('u', ['student']))).toBe(true)
  })

  it('聯絡資訊：案主本人（老師）與系辦；其他老師、學生不行', () => {
    expect(canManageOpportunity(actor('t1', ['teacher']), 't1')).toBe(true)
    expect(canManageOpportunity(actor('a', ['admin']), 't1')).toBe(true)
    expect(canManageOpportunity(actor('t2', ['teacher']), 't1')).toBe(false)
    expect(canManageOpportunity(actor('t1', ['student']), 't1')).toBe(false)
    expect(canManageOpportunity({ kind: 'anonymous' }, 't1')).toBe(false)
  })
})

describe('組長改類型的三個條件（5.3）', () => {
  it('全部符合才可以；不符合的條件全部列出', () => {
    expect(leaderTypeChangeBlockers({ groupingPeriod: 'open', hasAdvisor: false, hasLink: false })).toEqual([])
    expect(leaderTypeChangeBlockers({ groupingPeriod: 'ended', hasAdvisor: true, hasLink: true })).toEqual([
      '成組期已結束',
      '已經有指導老師',
      '已經連結合作案',
    ])
  })

  it('階段還沒設定、還沒開始時不說「已結束」（PR #266 審查建議）', () => {
    expect(leaderTypeChangeBlockers({ groupingPeriod: 'unconfigured', hasAdvisor: false, hasLink: false })).toEqual(['這一屆還沒設定成組期'])
    expect(leaderTypeChangeBlockers({ groupingPeriod: 'not_started', hasAdvisor: false, hasLink: false })).toEqual(['成組期還沒開始'])
  })

  it('歷程文字', () => {
    const entry = {
      at: new Date(),
      previousLeaderName: null,
      previousAdvisorName: null,
      byName: null,
      reason: null,
      groupTypes: null,
      previousOpportunityName: null,
    }
    expect(describeGroupHistory({ ...entry, kind: 'type_changed', userName: '王同學', groupTypes: { from: 'general', to: 'industry' } })).toBe(
      '組別類型 一般專題 → 產學合作（王同學）',
    )
    expect(describeGroupHistory({ ...entry, kind: 'opportunity_linked', userName: '乙・部', previousOpportunityName: '甲・部', byName: '系辦' })).toBe(
      '合作案 甲・部 → 乙・部（系辦）',
    )
    expect(describeGroupHistory({ ...entry, kind: 'opportunity_unlinked', userName: '甲・部' })).toBe('解除合作案連結：甲・部')
  })
})

function group(code: string, overrides: Partial<GroupSummary> = {}): GroupSummary {
  return {
    id: `00000000-0000-4000-8000-0000000000${code.slice(-2)}`,
    cohortId: 'c',
    code,
    groupType: 'general',
    establishedBusinessAt: new Date('2026-09-20T00:00:00Z'),
    revision: 1,
    members: [
      { userId: `${code}-1`, name: `${code}組長`, studentNo: '041200001', isLeader: true, loginEmail: `${code.toLowerCase()}-1@school.example` },
      { userId: `${code}-2`, name: `${code}組員`, studentNo: '041200002', isLeader: false, loginEmail: `${code.toLowerCase()}-2@gmail.com` },
    ],
    advisor: null,
    opportunity: null,
    history: [],
    ...overrides,
  }
}

describe('組別名單：篩選、排序（5.5）', () => {
  const teacher = '11111111-1111-4111-8111-111111111111'
  const groups = [
    group('G02', { groupType: 'industry' }),
    group('G10', { advisor: { teacherUserId: teacher, teacherName: '甲老師', source: 'admin', since: new Date() } }),
    group('G01', {
      groupType: 'industry',
      advisor: { teacherUserId: teacher, teacherName: '乙老師', source: 'claim', since: new Date() },
      opportunity: { linkId: 'l', opportunityId: 'o', name: '輔仁零售・資訊部', status: 'published' },
    }),
  ]

  it('類型、狀態、老師、搜尋', () => {
    const codes = (raw: Record<string, unknown>) => applyRosterFilter(groups, normalizeRosterFilter(raw)).map((g) => g.code)
    expect(codes({})).toEqual(['G01', 'G02', 'G10'])
    expect(codes({ type: 'industry' })).toEqual(['G01', 'G02'])
    expect(codes({ status: 'advisor_missing' })).toEqual(['G02'])
    expect(codes({ status: 'industry_unlinked' })).toEqual(['G02'])
    expect(codes({ advisor: teacher })).toEqual(['G01', 'G10'])
    expect(codes({ advisor: 'none' })).toEqual(['G02'])
    expect(codes({ q: 'G10組員' })).toEqual(['G10'])
    expect(codes({ q: 'GMAIL' })).toEqual(['G01', 'G02', 'G10'])
    expect(codes({ q: '零售' })).toEqual(['G01'])
  })

  it('排序：代碼自然排序、老師（未指派排最後）、反向', () => {
    const codes = (raw: Record<string, unknown>) => applyRosterFilter(groups, normalizeRosterFilter(raw)).map((g) => g.code)
    expect(codes({ sort: 'code', dir: 'desc' })).toEqual(['G10', 'G02', 'G01'])
    // 繁中排序依筆畫：乙（1 畫）在甲（5 畫）前面。
    expect(codes({ sort: 'advisor' })).toEqual(['G01', 'G10', 'G02'])
    expect(codes({ sort: 'advisor', dir: 'desc' })).toEqual(['G02', 'G10', 'G01'])
  })

  it('不認得的值回預設；網址只寫非預設值', () => {
    const filter = normalizeRosterFilter({ type: 'x', status: 'y', advisor: 'not-a-uuid', sort: 'z', dir: 'up', q: '  abc ' })
    expect(filter).toEqual({ type: 'all', status: 'all', advisor: 'all', q: 'abc', sort: 'code', dir: 'asc' })
    expect(rosterQueryString(filter, { sort: 'members', dir: 'desc' })).toBe('q=abc&sort=members&dir=desc')
  })
})

describe('複製本組信箱與匯出列（C18）', () => {
  it('登入信箱以逗號分隔，不限 gmail；沒有信箱的略過', () => {
    const g = group('G03')
    expect(groupEmailList(g)).toBe('g03-1@school.example, g03-2@gmail.com')
    expect(groupEmailList({ members: [{ ...g.members[0]!, loginEmail: null }] })).toBe('')
  })

  it('每位組員一列；CSV 開頭 BOM、全部加引號、公式字首加撇號', () => {
    const g = group('G04', { members: [{ userId: 'x', name: '=cmd|calc', studentNo: '0412', isLeader: true, loginEmail: 'a@x.org' }] })
    const rows = rosterExportRows('114', [g])
    expect(rows).toEqual([['114', 'G04', '一般專題', '尚未指派', '', '是', '0412', '=cmd|calc', 'a@x.org', 'a@x.org']])
    const csv = buildRosterCsv(rows)
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv.slice(1).startsWith('"屆別"')).toBe(true)
    expect(csv).toContain(`"'=cmd|calc"`)
    expect(csv).toContain('"0412"')
    expect(csv.endsWith('\r\n')).toBe(true)
  })

  it('匯出請求：格式、範圍、勾選數量都要合法', () => {
    const cohortId = '22222222-2222-4222-8222-222222222222'
    expect(normalizeRosterExportRequest({ cohortId, format: 'pdf', kind: 'filter' }).ok).toBe(false)
    expect(normalizeRosterExportRequest({ cohortId, format: 'csv', kind: 'ids', groupIds: [] }).ok).toBe(false)
    expect(normalizeRosterExportRequest({ cohortId, format: 'csv', kind: 'ids', groupIds: ['x'] }).ok).toBe(false)
    expect(normalizeRosterExportRequest({ cohortId: 'x', format: 'csv', kind: 'filter' }).ok).toBe(false)
    const ok = normalizeRosterExportRequest({ cohortId, format: 'xlsx', kind: 'filter', filter: { type: 'industry' } })
    expect(ok.ok && ok.value.selection).toEqual({ kind: 'filter', filter: normalizeRosterFilter({ type: 'industry' }) })
  })
})
