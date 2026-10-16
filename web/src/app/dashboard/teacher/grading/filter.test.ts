import { describe, expect, it } from 'vitest'
import { filterQueue, gradingStatusOf, neighbours, parseFilter, pickStage } from './filter'

type E = { groupId: string; stageKey: string; state: 'empty' | 'draft' | 'counted'; returned: boolean }

const entry = (groupId: string, state: E['state'], returned = false, stageKey = 'final'): E => ({ groupId, stageKey, state, returned })

// AC-TE-10 的情境：G01 已送、G02 草稿、G03 未填；另加一組被系辦退回、改到一半的 G04。
const G01 = entry('G01', 'counted')
const G02 = entry('G02', 'draft')
const G03 = entry('G03', 'empty')
const G04 = entry('G04', 'draft', true)
const ALL = [G01, G02, G03, G04]

describe('gradingStatusOf', () => {
  it('沒有評分列是待評、最新是草稿是草稿、採計是已送出', () => {
    expect(gradingStatusOf(G03)).toBe('pending')
    expect(gradingStatusOf(G02)).toBe('draft')
    expect(gradingStatusOf(G01)).toBe('submitted')
  })

  it('被系辦退回、還沒重新送出的歸「待評」（即使已有新草稿）', () => {
    expect(gradingStatusOf(G04)).toBe('pending')
    expect(gradingStatusOf(entry('G05', 'empty', true))).toBe('pending')
  })
})

describe('filterQueue', () => {
  it('全部：原樣、順序不變', () => {
    expect(filterQueue(ALL, 'all')).toEqual(ALL)
  })

  it('待評：沒評過的與被退回的', () => {
    expect(filterQueue(ALL, 'pending')).toEqual([G03, G04])
  })

  it('草稿：只剩草稿（被退回的不算）', () => {
    expect(filterQueue(ALL, 'draft')).toEqual([G02])
  })

  it('已送出：只剩採計的', () => {
    expect(filterQueue(ALL, 'submitted')).toEqual([G01])
  })

  it('沒有符合的回空陣列', () => {
    expect(filterQueue([G01], 'draft')).toEqual([])
  })
})

describe('parseFilter', () => {
  it('認得四種值，其他（含沒帶、陣列）一律當全部', () => {
    expect(parseFilter('pending')).toBe('pending')
    expect(parseFilter('draft')).toBe('draft')
    expect(parseFilter('submitted')).toBe('submitted')
    expect(parseFilter('all')).toBe('all')
    expect(parseFilter(undefined)).toBe('all')
    expect(parseFilter('nope')).toBe('all')
    expect(parseFilter(['draft', 'pending'])).toBe('all')
  })
})

describe('pickStage', () => {
  const s1Done = entry('G01', 'counted', false, 'proposal')
  const s2Todo = entry('G01', 'empty', false, 'final')

  it('網址指定且存在就用它', () => {
    expect(pickStage([s1Done, s2Todo], 'proposal')).toBe('proposal')
  })

  it('沒指定或指定不存在：第一個還有沒送出的階段', () => {
    expect(pickStage([s1Done, s2Todo], undefined)).toBe('final')
    expect(pickStage([s1Done, s2Todo], 'ghost')).toBe('final')
  })

  it('全部都送出了：第一個階段', () => {
    expect(pickStage([s1Done, entry('G02', 'counted', false, 'final')], undefined)).toBe('proposal')
  })

  it('沒有任何指派：null', () => {
    expect(pickStage([], 'final')).toBeNull()
  })
})

describe('neighbours', () => {
  it('中間那組：上一組與下一組', () => {
    expect(neighbours(ALL, 'G02')).toEqual({ prev: G01, next: G03 })
  })

  it('第一組沒有上一組、最後一組沒有下一組', () => {
    expect(neighbours(ALL, 'G01')).toEqual({ prev: null, next: G02 })
    expect(neighbours(ALL, 'G04')).toEqual({ prev: G03, next: null })
  })

  it('不在清單裡（或清單只有自己）：兩邊都是 null', () => {
    expect(neighbours(ALL, 'G99')).toEqual({ prev: null, next: null })
    expect(neighbours([G01], 'G01')).toEqual({ prev: null, next: null })
  })
})
