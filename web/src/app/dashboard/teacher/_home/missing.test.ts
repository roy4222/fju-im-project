import { describe, expect, it } from 'vitest'
import type { AdvisorMatrix, AdvisorMatrixCell, AdvisorMatrixItem, AdvisedGroup } from '@/application/submissions'
import { missingSubmissions } from '@/app/dashboard/teacher/_home/missing'

const NOW = new Date('2026-10-16T04:00:00Z')
const YESTERDAY = new Date('2026-10-15T04:00:00Z')
const NEXT_WEEK = new Date('2026-10-23T04:00:00Z')

function group(code: string, cohortId = 'c1'): AdvisedGroup {
  return { groupId: code.toLowerCase(), code, groupType: 'general', cohortId, cohortCode: '114', cohortName: '第 42 屆', memberNames: [] }
}

function item(itemId: string, title: string, dueAt: Date | null, cohortId = 'c1'): AdvisorMatrixItem {
  return { itemId, title, cohortId, stageName: null, opensAt: new Date('2026-09-01T00:00:00Z'), dueAt }
}

function cell(groupId: string, itemId: string, patch: Partial<AdvisorMatrixCell> = {}): AdvisorMatrixCell {
  return {
    groupId,
    itemId,
    eligibleTo: null,
    exempt: false,
    latestVersionNo: null,
    latestReceivedAt: null,
    latestSubmittedByName: null,
    reopenUntil: null,
    ...patch,
  }
}

function matrix(parts: Partial<AdvisorMatrix>): AdvisorMatrix {
  return { groups: [], items: [], cells: [], individualItems: [], ...parts }
}

describe('缺件的組（D1 定案：截止已過且沒有正式送出）', () => {
  it('期中報告昨天截止：沒交的 G02 缺 1 份；已交的 G01 不出現；下週截止的海報不算缺件', () => {
    const m = matrix({
      groups: [group('G01'), group('G02')],
      items: [item('mid', '期中報告', YESTERDAY), item('poster', '海報', NEXT_WEEK)],
      cells: [
        cell('g01', 'mid', { latestVersionNo: 1, latestReceivedAt: YESTERDAY }),
        cell('g02', 'mid'),
        cell('g01', 'poster'),
        cell('g02', 'poster'),
      ],
    })
    expect(missingSubmissions(m, NOW)).toEqual([{ groupId: 'g02', code: 'G02', titles: ['期中報告'] }])
  })

  it('一組缺兩份：標題照收件順序列在同一行', () => {
    const m = matrix({
      groups: [group('G01')],
      items: [item('a', '期中報告', YESTERDAY), item('b', '海報', YESTERDAY)],
      cells: [cell('g01', 'a'), cell('g01', 'b')],
    })
    expect(missingSubmissions(m, NOW)).toEqual([{ groupId: 'g01', code: 'G01', titles: ['期中報告', '海報'] }])
  })

  it('免填、已移出名單、不在名單上（沒有格子）的都不算缺件', () => {
    const m = matrix({
      groups: [group('G01'), group('G02'), group('G03')],
      items: [item('a', '期中報告', YESTERDAY)],
      cells: [cell('g01', 'a', { exempt: true }), cell('g02', 'a', { eligibleTo: YESTERDAY })],
    })
    expect(missingSubmissions(m, NOW)).toEqual([])
  })

  it('系辦開放個別補交、期限還沒到：截止被延後，不算缺件；補交期限也過了才算', () => {
    const m = matrix({
      groups: [group('G01'), group('G02')],
      items: [item('a', '期中報告', YESTERDAY)],
      cells: [cell('g01', 'a', { reopenUntil: NEXT_WEEK }), cell('g02', 'a', { reopenUntil: new Date('2026-10-16T01:00:00Z') })],
    })
    expect(missingSubmissions(m, NOW)).toEqual([{ groupId: 'g02', code: 'G02', titles: ['期中報告'] }])
  })

  it('沒有截止時間的收件永遠不算缺件', () => {
    const m = matrix({ groups: [group('G01')], items: [item('a', '心得', null)], cells: [cell('g01', 'a')] })
    expect(missingSubmissions(m, NOW)).toEqual([])
  })

  it('別屆的收件不算到這一組（矩陣欄是所有指導屆別的聯集）', () => {
    const m = matrix({
      groups: [group('G01', 'c1')],
      items: [item('a', '別屆期中報告', YESTERDAY, 'c2')],
      cells: [cell('g01', 'a')],
    })
    expect(missingSubmissions(m, NOW)).toEqual([])
  })

  it('組別順序照矩陣（老師指導的組）的順序；沒有矩陣（不是主指導）回空陣列', () => {
    const m = matrix({
      groups: [group('G03'), group('G01')],
      items: [item('a', '期中報告', YESTERDAY)],
      cells: [cell('g01', 'a'), cell('g03', 'a')],
    })
    expect(missingSubmissions(m, NOW).map((g) => g.code)).toEqual(['G03', 'G01'])
    expect(missingSubmissions(null, NOW)).toEqual([])
  })
})
