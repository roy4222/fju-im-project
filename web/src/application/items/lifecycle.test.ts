import { describe, expect, it } from 'vitest'
import {
  describeLifecycleReceipt,
  describeRepublishExpired,
  lifecycleCheck,
  publicAccessOf,
  type AudienceKind,
  type ItemStatus,
  type Viewer,
} from '@/application/items'

const COHORT = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const G1 = '33333333-3333-4333-8333-333333333333'

describe('lifecycleCheck：撤回、下架、重新發布只在對的狀態', () => {
  it('撤回：只有發布中、而且沒有任何回答', () => {
    expect(lifecycleCheck('withdraw', 'published', false)).toEqual({ ok: true })
    expect(lifecycleCheck('withdraw', 'published', true)).toMatchObject({ ok: false, code: 'ITEM_HAS_RESPONSES' })
    expect(lifecycleCheck('withdraw', 'draft', false)).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(lifecycleCheck('withdraw', 'archived', false)).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
  })

  it('下架：只有發布中；有沒有回答都可以', () => {
    expect(lifecycleCheck('archive', 'published', true)).toEqual({ ok: true })
    expect(lifecycleCheck('archive', 'draft', false).ok).toBe(false)
    expect(lifecycleCheck('archive', 'archived', false).ok).toBe(false)
  })

  it('重新發布：只有已下架；草稿（含撤回的）要用「發布」', () => {
    expect(lifecycleCheck('republish', 'archived', true)).toEqual({ ok: true })
    const draft = lifecycleCheck('republish', 'draft', false)
    expect(draft.ok || draft.message).toContain('發布')
    expect(lifecycleCheck('republish', 'published', false).ok).toBe(false)
  })
})

describe('describeRepublishExpired：已截止的收件不能直接重新發布', () => {
  it('寫出截止時間（臺灣時間）與下一步', () => {
    const text = describeRepublishExpired(new Date('2026-11-15T15:59:00Z'))
    expect(text).toContain('2026/11/15 23:59，臺灣時間')
    expect(text).toContain('另建一份新的收件')
  })
})

describe('describeLifecycleReceipt：回執一句話帶出下一步與實際開放時間', () => {
  const base = { itemId: 'x', title: '期中報告', revision: 3, actualOpenedAt: '2026-09-24T02:00:00.000Z', rosterClosed: 0 }

  it('撤回說明名單結束、改好再發布；開放時間不變', () => {
    const text = describeLifecycleReceipt({ ...base, action: 'withdraw', status: 'draft', rosterClosed: 4 })
    expect(text).toContain('已撤回成草稿')
    expect(text).toContain('收件名單 4 筆已結束')
    expect(text).toContain('按「發布」')
    expect(text).toContain('2026/09/24 10:00')
  })

  it('下架說明前台會顯示已下架；重新發布帶原本的開放時間', () => {
    expect(describeLifecycleReceipt({ ...base, action: 'archive', status: 'archived' })).toContain('前台網址會顯示「已下架」')
    expect(describeLifecycleReceipt({ ...base, action: 'republish', status: 'published' })).toContain('實際開放時間仍是 2026/09/24 10:00')
  })
})

describe('publicAccessOf：前台內容頁顯示什麼', () => {
  const anonymous: Viewer = { kind: 'anonymous' }
  const student = (cohort = COHORT, groupIds: string[] = []): Viewer => ({
    kind: 'user',
    roles: ['student'],
    studentCohortId: cohort,
    groupIds,
  })
  const admin: Viewer = { kind: 'user', roles: ['admin'], studentCohortId: null, groupIds: [] }
  const item = (audienceKind: AudienceKind, status: ItemStatus = 'published', everPublished = status !== 'draft') => ({
    status,
    audienceKind,
    cohortId: COHORT,
    groupIds: [G1],
    everPublished,
  })

  it('發布中：在對象內看得到；訪客遇到非公開要登入；登入但不在對象內＝找不到', () => {
    expect(publicAccessOf(anonymous, item('public'))).toBe('visible')
    expect(publicAccessOf(anonymous, item('signed_in'))).toBe('need_login')
    expect(publicAccessOf(student(), item('cohort_students'))).toBe('visible')
    expect(publicAccessOf(student(OTHER), item('cohort_students'))).toBe('not_found')
    expect(publicAccessOf(student(COHORT, [G1]), item('groups'))).toBe('visible')
    expect(publicAccessOf(student(COHORT, []), item('groups'))).toBe('not_found')
  })

  it('已下架：原本看得到的人看到「已下架」（不是 404）；不在對象內的人一樣找不到', () => {
    expect(publicAccessOf(anonymous, item('public', 'archived'))).toBe('archived')
    expect(publicAccessOf(student(), item('cohort_students', 'archived'))).toBe('archived')
    expect(publicAccessOf(anonymous, item('cohort_students', 'archived'))).toBe('need_login')
    expect(publicAccessOf(student(OTHER), item('cohort_students', 'archived'))).toBe('not_found')
  })

  it('撤回（發布過的草稿）顯示「已撤回」；從沒發布過的草稿連管理員在前台都是找不到', () => {
    expect(publicAccessOf(anonymous, item('public', 'draft', true))).toBe('withdrawn')
    expect(publicAccessOf(anonymous, item('public', 'draft', false))).toBe('not_found')
    expect(publicAccessOf(admin, item('public', 'draft', false))).toBe('not_found')
  })
})
