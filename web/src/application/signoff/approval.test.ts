import { describe, expect, it } from 'vitest'
import {
  buildProgress,
  causeForRestart,
  checkVoid,
  checkVote,
  nextRemindAt,
  nextStateAfterVote,
  normalizeReason,
  REMIND_COOLDOWN_MS,
  remindable,
  remindRecipients,
  restartKindFor,
  resultFor,
  roleIn,
  supersedesOnRestart,
  type VoteFacts,
} from '@/application/signoff/approval'
import { buildSignoffCsv, buildSignoffPrintable, type SignoffExportData } from '@/application/signoff/export'
import type { Participants } from '@/application/signoff/version'

/** 票 26：表態、狀態轉移、重置／重開、提醒與匯出的純規則。 */

const participants: Participants = {
  students: [
    { userId: 's1', displayName: '甲', studentNo: '411000001', membershipId: 'm1' },
    { userId: 's2', displayName: '乙', studentNo: '411000002', membershipId: 'm2' },
    { userId: 's3', displayName: '丙', studentNo: '411000003', membershipId: 'm3' },
  ],
  advisor: { userId: 't1', displayName: '王老師', assignmentId: 'a1' },
}

const ok: VoteFacts = {
  isCurrent: true,
  state: 'collecting',
  cause: null,
  checksumMatches: true,
  role: 'student',
  stillEligible: true,
  alreadyVoted: false,
}

describe('checkVote：誰、什麼時候能投', () => {
  it('收集中的參與學生可以投', () => {
    expect(checkVote(ok)).toBeNull()
  })

  it('已失效（含不是目前那一版）→ VERSION_SUPERSEDED，說出原因', () => {
    expect(checkVote({ ...ok, state: 'superseded', cause: 'advisor_change' })).toMatchObject({ code: 'VERSION_SUPERSEDED' })
    expect(checkVote({ ...ok, state: 'superseded', cause: 'advisor_change' })?.message).toContain('指導老師變更')
    expect(checkVote({ ...ok, isCurrent: false, state: 'complete' })).toMatchObject({ code: 'VERSION_SUPERSEDED' })
  })

  it('內容核對碼不符（舊頁）→ VERSION_SUPERSEDED；作廢 → CONFLICT', () => {
    expect(checkVote({ ...ok, checksumMatches: false })).toMatchObject({ code: 'VERSION_SUPERSEDED' })
    expect(checkVote({ ...ok, state: 'void' })).toMatchObject({ code: 'CONFLICT' })
  })

  it('不是參與者、或已失去資格（被移出、換掉的老師）→ NOT_PARTICIPANT', () => {
    expect(checkVote({ ...ok, role: null })).toMatchObject({ code: 'NOT_PARTICIPANT' })
    expect(checkVote({ ...ok, role: 'advisor', state: 'teacher_pending', stillEligible: false })).toMatchObject({ code: 'NOT_PARTICIPANT' })
  })

  it('投過 → ALREADY_VOTED；已完成 → ALREADY_VOTED；退回中 → CONFLICT', () => {
    expect(checkVote({ ...ok, alreadyVoted: true })).toMatchObject({ code: 'ALREADY_VOTED' })
    expect(checkVote({ ...ok, role: 'advisor', state: 'complete' })).toMatchObject({ code: 'ALREADY_VOTED' })
    expect(checkVote({ ...ok, state: 'revision' })).toMatchObject({ code: 'CONFLICT' })
  })

  it('老師在學生沒全同意前 → STUDENTS_PENDING；等老師時可以；學生在等老師時不能再投', () => {
    expect(checkVote({ ...ok, role: 'advisor' })).toMatchObject({ code: 'STUDENTS_PENDING' })
    expect(checkVote({ ...ok, role: 'advisor', state: 'teacher_pending' })).toBeNull()
    expect(checkVote({ ...ok, state: 'teacher_pending' })).toMatchObject({ code: 'CONFLICT' })
  })
})

describe('狀態轉移', () => {
  it('最後一位學生同意才轉等老師（依快照人數：三人組 3／3）', () => {
    expect(nextStateAfterVote('student', 'agree', { studentsTotal: 5, studentsAgreedIncludingThis: 4 })).toBeNull()
    expect(nextStateAfterVote('student', 'agree', { studentsTotal: 5, studentsAgreedIncludingThis: 5 })).toBe('teacher_pending')
    expect(nextStateAfterVote('student', 'agree', { studentsTotal: 3, studentsAgreedIncludingThis: 3 })).toBe('teacher_pending')
  })

  it('任一學生不同意、老師退回 → 修正中；老師同意 → 完成', () => {
    expect(nextStateAfterVote('student', 'disagree', { studentsTotal: 5, studentsAgreedIncludingThis: 0 })).toBe('revision')
    expect(nextStateAfterVote('advisor', 'return', { studentsTotal: 5, studentsAgreedIncludingThis: 5 })).toBe('revision')
    expect(nextStateAfterVote('advisor', 'agree', { studentsTotal: 5, studentsAgreedIncludingThis: 5 })).toBe('complete')
  })

  it('角色與結果：學生不同意＝disagree、老師不同意＝return；角色看快照', () => {
    expect(resultFor('student', 'reject')).toBe('disagree')
    expect(resultFor('advisor', 'reject')).toBe('return')
    expect(roleIn(participants, 's2')).toBe('student')
    expect(roleIn(participants, 't1')).toBe('advisor')
    expect(roleIn(participants, 'admin')).toBeNull()
  })

  it('理由：要理由的沒填或只有空白被拒；太長被拒；不要理由的空字串變 null', () => {
    expect(normalizeReason('  ', true, '不同意')).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(normalizeReason('x'.repeat(501), true, '不同意')).toMatchObject({ ok: false })
    expect(normalizeReason(' 有錯字 ', true, '不同意')).toEqual({ ok: true, reason: '有錯字' })
    expect(normalizeReason('', false, '同意')).toEqual({ ok: true, reason: null })
  })
})

describe('進度與缺誰', () => {
  it('人數照快照；缺誰列還沒表態的學生與老師；已結束的版本不列缺誰', () => {
    const at = new Date('2027-01-05T02:00:00Z')
    const p = buildProgress(participants, [{ userId: 's1', role: 'student', result: 'agree', reason: null, realAt: at }], 'collecting')
    expect(p).toMatchObject({ agreed: 1, total: 3, missing: ['乙', '丙', '王老師（主指導）'] })
    expect(p.students[0]).toMatchObject({ result: 'agree', at })
    expect(buildProgress(participants, [], 'void').missing).toEqual([])
    expect(remindRecipients(p)).toEqual(['s2', 's3', 't1'])
  })
})

describe('重置、重開、作廢、提醒', () => {
  it('收集中、等老師、已完成用「重置」；退回、失效、作廢用「重開新版」', () => {
    expect(restartKindFor('collecting')).toBe('reset')
    expect(restartKindFor('teacher_pending')).toBe('reset')
    expect(restartKindFor('complete')).toBe('reset')
    expect(restartKindFor('revision')).toBe('reopen')
    expect(restartKindFor('superseded')).toBe('reopen')
    expect(restartKindFor('void')).toBe('reopen')
  })

  it('舊版：收集中、等老師、退回改已失效；已完成、已失效、已作廢不動', () => {
    expect(['collecting', 'teacher_pending', 'revision'].every((s) => supersedesOnRestart(s as 'collecting'))).toBe(true)
    expect(['complete', 'superseded', 'void'].some((s) => supersedesOnRestart(s as 'complete'))).toBe(false)
  })

  it('新版原因：因組員／老師變更而失效的沿用；其他一律系辦重置（CHECK 沒有 reopen）', () => {
    expect(causeForRestart({ state: 'superseded', cause: 'member_change' })).toBe('member_change')
    expect(causeForRestart({ state: 'superseded', cause: 'advisor_change' })).toBe('advisor_change')
    expect(causeForRestart({ state: 'revision', cause: '錯字' })).toBe('reset')
    expect(causeForRestart({ state: 'void', cause: '改期' })).toBe('reset')
  })

  it('作廢：已作廢的不能再作廢', () => {
    expect(checkVoid('void')).toMatchObject({ code: 'CONFLICT' })
    expect(checkVoid('complete')).toBeNull()
  })

  it('提醒：只有收集中與等老師；24 小時內回下一次可以提醒的時間', () => {
    expect(remindable('collecting') && remindable('teacher_pending')).toBe(true)
    expect(remindable('complete') || remindable('revision') || remindable('superseded') || remindable('void')).toBe(false)
    const last = new Date('2027-01-05T02:00:00Z')
    expect(nextRemindAt(null, last)).toBeNull()
    expect(nextRemindAt(last, new Date(last.getTime() + REMIND_COOLDOWN_MS - 1))?.getTime()).toBe(last.getTime() + REMIND_COOLDOWN_MS)
    expect(nextRemindAt(last, new Date(last.getTime() + REMIND_COOLDOWN_MS))).toBeNull()
  })
})

describe('匯出', () => {
  const at = new Date('2027-01-05T02:00:00Z')
  const data: SignoffExportData = {
    cohortCode: '115',
    groupCode: 'G01',
    purpose: 'result_confirmation',
    versionId: 'v-1',
    versionNo: 1,
    contentChecksum: 'abc',
    contentHtml: '<p>全文</p>',
    attachments: [],
    authorizationScope: null,
    participants,
    state: 'revision',
    cause: '@SUM(A1)',
    isCurrent: true,
    votes: [
      {
        eventId: 'e1',
        userId: 's1',
        displayNameAt: '甲',
        studentNoAt: '0411000001',
        role: 'student',
        loginMethod: 'password',
        buttonText: '不同意並退回修正',
        result: 'disagree',
        reason: '=1+1',
        realAt: at,
        businessAt: at,
      },
    ],
    lifecycle: [],
    exportedAt: at,
    exportedByName: '系辦<b>',
  }

  it('CSV：BOM、CRLF、公式字首加 \'、學號前導零保留、臺灣時間', () => {
    const csv = buildSignoffCsv(data)
    expect(csv.startsWith('﻿')).toBe(true)
    expect(csv.endsWith('\r\n')).toBe(true)
    expect(csv).toContain(`"'=1+1"`)
    expect(csv).toContain('"退回修正中（@SUM(A1)）"')
    expect(csv).toContain('"0411000001"')
    expect(csv).toContain('"2027/01/05 10:00:00"')
  })

  it('可列印頁：其他欄位全部逸出，只有清洗過的全文原樣輸出', () => {
    const html = buildSignoffPrintable(data)
    expect(html).toContain('<p>全文</p>')
    expect(html).toContain('系辦&lt;b&gt;')
    expect(html).toContain('站內內容確認與同意紀錄，行政採認待確認')
  })
})
