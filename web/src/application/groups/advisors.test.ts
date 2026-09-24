import { describe, expect, it } from 'vitest'
import {
  analyzeAdvisorCsv,
  describeAdvisorBatchReceipt,
  describeAdvisorChangeReceipt,
  planBatch,
  type AdvisorBatchAnalysis,
  type BatchGroupFact,
  type BatchLookup,
  type BatchTeacherFact,
} from '@/application/groups/advisors'
import { describeGroupHistory } from '@/application/groups/history'

/**
 * 票 19：批次指派 CSV 的六類分析與執行前的整批判斷（產品模組 03 §4「行政指派的輸入」；GRP-17）。
 */

const group = (code: string, patch: Partial<BatchGroupFact> = {}): BatchGroupFact => ({
  id: `00000000-0000-4000-8000-0000000000${code.slice(-2)}`,
  code,
  status: 'active',
  revision: 3,
  advisor: null,
  ...patch,
})

const teacher = (email: string, patch: Partial<BatchTeacherFact> = {}): BatchTeacherFact => ({
  userId: `user-${email}`,
  name: email.split('@')[0]!,
  loginEmail: email,
  eligible: true,
  ...patch,
})

function lookup(): BatchLookup {
  return {
    groupsByCode: new Map([
      ['G01', group('G01')],
      ['G02', group('G02', { advisor: { teacherUserId: 'user-wang@fju.edu.tw', teacherName: 'wang' } })],
      ['G03', group('G03', { advisor: { teacherUserId: 'user-lee@fju.edu.tw', teacherName: 'lee' } })],
      ['G04', group('G04', { status: 'dissolved' })],
      ['G05', group('G05')],
      ['G06', group('G06')],
    ]),
    teachersByLoginEmail: new Map([
      ['wang@fju.edu.tw', teacher('wang@fju.edu.tw')],
      ['lee@fju.edu.tw', teacher('lee@fju.edu.tw')],
      ['off@fju.edu.tw', teacher('off@fju.edu.tw', { eligible: false })],
    ]),
    teacherLoginByContactEmail: new Map([['wang.personal@gmail.com', 'wang@fju.edu.tw']]),
  }
}

function analyze(text: string): AdvisorBatchAnalysis {
  const result = analyzeAdvisorCsv(text, lookup())
  if (!result.ok) throw new Error(result.message)
  return result.analysis
}

describe('批次指派 CSV：六類預覽', () => {
  it('GRP-17 的每一種情況各分到正確的類別', () => {
    const analysis = analyze(
      [
        'group_code,teacher_login_email',
        'G01,wang@fju.edu.tw', // 可新增
        'g02, WANG@fju.edu.tw ', // 已是同一位（代碼大小寫、Email 大小寫與空白都不影響）
        'G03,wang@fju.edu.tw', // 已有不同老師 → 重派
        'G99,wang@fju.edu.tw', // 組別不存在
        'G04,wang@fju.edu.tw', // 已解散
        'G05,off@fju.edu.tw', // 老師停用
        'G06,wang.personal@gmail.com', // 用聯絡 Email
        'G07,nobody@fju.edu.tw', // G07 不存在（組別先判）
      ].join('\n'),
    )
    expect(analysis.rows.map((r) => [r.line, r.kind])).toEqual([
      [2, 'new'],
      [3, 'unchanged'],
      [4, 'reassign'],
      [5, 'group_missing'],
      [6, 'group_missing'],
      [7, 'teacher_missing'],
      [8, 'teacher_missing'],
      [9, 'group_missing'],
    ])
    expect(analysis.rows[4]!.message).toContain('已解散')
    expect(analysis.rows[5]!.message).toContain('已停用')
    expect(analysis.rows[6]!.message).toContain('聯絡 Email')
    expect(analysis.rows[6]!.message).toContain('wang@fju.edu.tw')
    expect(analysis.rows[2]!.currentTeacherName).toBe('lee')
    expect(analysis.rows[0]!.groupRevision).toBe(3)
    expect(analysis.counts).toMatchObject({
      total: 8,
      new: 1,
      unchanged: 1,
      reassign: 1,
      group_missing: 3,
      teacher_missing: 2,
      duplicate: 0,
    })
  })

  it('同一組在檔案裡出現兩次：兩列都標重複（就算老師一樣）', () => {
    const analysis = analyze('group_code,teacher_login_email\nG01,wang@fju.edu.tw\nG05,lee@fju.edu.tw\ng01,wang@fju.edu.tw\n')
    expect(analysis.rows.map((r) => r.kind)).toEqual(['duplicate', 'new', 'duplicate'])
    expect(analysis.counts.duplicate).toBe(2)
  })

  it('欄位順序不拘；空白列略過；空的代碼或 Email 各歸各類', () => {
    const analysis = analyze('teacher_login_email,group_code\r\nwang@fju.edu.tw,G01\r\n\r\n,G05\r\nlee@fju.edu.tw,\r\n')
    expect(analysis.rows.map((r) => [r.line, r.kind])).toEqual([
      [2, 'new'],
      [4, 'teacher_missing'],
      [5, 'group_missing'],
    ])
  })

  it('整份看不懂就退件，不猜：表頭、欄數、只有表頭、引號、BOM 可以', () => {
    const bad = (text: string) => {
      const result = analyzeAdvisorCsv(text, lookup())
      expect(result.ok).toBe(false)
      return result.ok ? '' : result.message
    }
    expect(bad('')).toContain('表頭')
    expect(bad('group,teacher\nG01,a@b.c')).toContain('不認得')
    expect(bad('group_code\nG01')).toContain('teacher_login_email')
    expect(bad('group_code,teacher_login_email\n')).toContain('只有表頭')
    expect(bad('group_code,teacher_login_email\nG01,a@b.c,extra')).toContain('第 2 行')
    expect(bad('group_code,teacher_login_email\n"G01,a@b.c')).toContain('引號')
    expect(analyzeAdvisorCsv('﻿group_code,teacher_login_email\nG01,wang@fju.edu.tw', lookup()).ok).toBe(true)
  })
})

describe('批次指派：執行前的整批判斷', () => {
  const clean = () => analyze('group_code,teacher_login_email\nG01,wang@fju.edu.tw\nG02,wang@fju.edu.tw\nG03,wang@fju.edu.tw')
  const revisions = (analysis: AdvisorBatchAnalysis) =>
    Object.fromEntries(analysis.rows.filter((r) => r.groupId).map((r) => [r.groupId!, r.groupRevision!]))

  it('有任何錯誤列就整批不做', () => {
    const analysis = analyze('group_code,teacher_login_email\nG01,wang@fju.edu.tw\nG99,wang@fju.edu.tw')
    const plan = planBatch(analysis, { reason: '抽籤', confirmReassign: true, revisions: revisions(analysis) })
    expect(plan).toMatchObject({ ok: false })
    expect(plan.ok ? '' : plan.message).toContain('1 列錯誤')
  })

  it('理由必填；有重派要勾確認', () => {
    const analysis = clean()
    expect(planBatch(analysis, { reason: ' ', confirmReassign: true, revisions: revisions(analysis) }).ok).toBe(false)
    const unconfirmed = planBatch(analysis, { reason: '抽籤', confirmReassign: false, revisions: revisions(analysis) })
    expect(unconfirmed.ok ? '' : unconfirmed.message).toContain('確認重派')
  })

  it('照預覽執行：新增與重派 apply、同一位 unchanged', () => {
    const analysis = clean()
    const plan = planBatch(analysis, { reason: '抽籤', confirmReassign: true, revisions: revisions(analysis) })
    expect(plan.ok && plan.steps.map((s) => [s.row.groupCode, s.action])).toEqual([
      ['G01', 'apply'],
      ['G02', 'unchanged'],
      ['G03', 'apply'],
    ])
  })

  it('預覽後被改過的那一組（版本不符或預覽沒看到）是 conflict，其他照做；也不因它要求確認重派', () => {
    const analysis = clean()
    const stale = { ...revisions(analysis), [analysis.rows[2]!.groupId!]: 2 }
    const plan = planBatch(analysis, { reason: '抽籤', confirmReassign: false, revisions: stale })
    expect(plan.ok && plan.steps.map((s) => s.action)).toEqual(['apply', 'unchanged', 'conflict'])
    const missing = planBatch(analysis, { reason: '抽籤', confirmReassign: true, revisions: {} })
    expect(missing.ok && missing.steps.map((s) => s.action)).toEqual(['conflict', 'conflict', 'conflict'])
  })

  it('全部都不需變更就不執行', () => {
    const analysis = analyze('group_code,teacher_login_email\nG02,wang@fju.edu.tw')
    const plan = planBatch(analysis, { reason: '抽籤', confirmReassign: false, revisions: revisions(analysis) })
    expect(plan.ok ? '' : plan.message).toContain('沒有需要變更')
  })
})

describe('回執與歷程的文字', () => {
  it('四種變更各一句', () => {
    const base = { groupId: 'g', groupCode: 'G01', teacherName: '王老師', previousTeacherName: null }
    expect(describeAdvisorChangeReceipt({ ...base, change: 'claimed' })).toContain('已指定為你的組別')
    expect(describeAdvisorChangeReceipt({ ...base, change: 'assigned' })).toContain('已指派 王老師')
    expect(describeAdvisorChangeReceipt({ ...base, change: 'reassigned', previousTeacherName: '李老師' })).toContain(
      '從 李老師 換成 王老師',
    )
    expect(describeAdvisorChangeReceipt({ ...base, change: 'unassigned', teacherName: null, previousTeacherName: '李老師' })).toContain(
      '已解除 李老師',
    )
  })

  it('批次回執：有衝突時要求重新預覽', () => {
    const counts = { assigned: 2, reassigned: 1, unchanged: 1, conflict: 1, failed: 0 }
    expect(describeAdvisorBatchReceipt({ cohortId: 'c', fileName: 'a.csv', results: [], counts })).toContain('重新上傳預覽')
    expect(describeAdvisorBatchReceipt({ cohortId: 'c', fileName: 'a.csv', results: [], counts: { ...counts, conflict: 0 } })).toContain(
      '新增 2 組、重派 1 組',
    )
  })

  it('主指導的歷程：首次、重派、解除', () => {
    const at = new Date('2026-09-25T02:00:00Z')
    const base = { at, previousLeaderName: null, byName: null, reason: null }
    expect(describeGroupHistory({ ...base, kind: 'advisor_assigned', userName: '王老師', previousAdvisorName: null })).toBe('指導老師：王老師')
    expect(
      describeGroupHistory({ ...base, kind: 'advisor_assigned', userName: '王老師', previousAdvisorName: '李老師', byName: '系辦' }),
    ).toBe('指導老師 李老師 → 王老師（系辦）')
    expect(describeGroupHistory({ ...base, kind: 'advisor_removed', userName: '王老師', previousAdvisorName: null })).toBe(
      '解除指導老師 王老師',
    )
  })
})
