import { describe, expect, it } from 'vitest'
import {
  DELETE_HAS_RESPONSES_MESSAGE,
  deleteCheck,
  describeDeleteReceipt,
  editableInArchivedCohort,
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

describe('deleteCheck：刪除只限草稿與已下架、有人交件的擋下（第三波 W1）', () => {
  it('草稿、已下架沒有回答可以刪', () => {
    expect(deleteCheck('draft', false)).toEqual({ ok: true })
    expect(deleteCheck('archived', false)).toEqual({ ok: true })
  })

  it('發布中不能刪：要先撤回或下架', () => {
    const refused = deleteCheck('published', false)
    expect(refused).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(refused.ok || refused.message).toContain('發布中的項目不能刪除')
    expect(refused.ok || refused.message).toContain('先撤回或下架')
  })

  it('已有人交件（存過草稿或正式送出）不能刪，只能下架（Q28）', () => {
    expect(deleteCheck('archived', true)).toEqual({ ok: false, code: 'ITEM_HAS_RESPONSES', message: DELETE_HAS_RESPONSES_MESSAGE })
    expect(DELETE_HAS_RESPONSES_MESSAGE).toBe('已經有學生交件，只能下架，不能刪除。')
  })

  it('回執說清楚不能恢復、通知不收回', () => {
    const text = describeDeleteReceipt({ itemId: 'x', cohortId: COHORT, title: '說明會', status: 'archived' })
    expect(text).toContain('「說明會」已刪除')
    expect(text).toContain('不能恢復')
    expect(text).toContain('通知不會收回')
  })
})

describe('editableInArchivedCohort：封存屆別只剩榮譽可以動', () => {
  it('榮譽可以；其他位置不行', () => {
    expect(editableInArchivedCohort('honor')).toBe(true)
    for (const p of ['news', 'resource', 'submission', 'rules', 'showcase', 'requirement']) expect(editableInArchivedCohort(p)).toBe(false)
  })
})

describe('describeRepublishExpired：已截止的收件不能直接重新發布', () => {
  it('寫出截止時間（臺灣時間）與下一步', () => {
    const text = describeRepublishExpired(new Date('2026-11-15T15:59:00Z'))
    expect(text).toContain('2026/11/15 23:59，臺灣時間')
    expect(text).toContain('另建一個新的作業')
  })
})

describe('describeLifecycleReceipt：回執一句話帶出下一步與實際開放時間', () => {
  const base = { itemId: 'x', title: '期中報告', revision: 3, actualOpenedAt: '2026-09-24T02:00:00.000Z', rosterClosed: 0 }

  it('撤回說明名單結束、改好再發布；開放時間不變', () => {
    const text = describeLifecycleReceipt({ ...base, action: 'withdraw', status: 'draft', rosterClosed: 4 })
    expect(text).toContain('已撤回成草稿')
    expect(text).toContain('需要繳交的名單 4 筆已結束')
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
    advisedGroupIds: [],
    advisedCohortIds: [],
  })
  const admin: Viewer = { kind: 'user', roles: ['admin'], studentCohortId: null, groupIds: [], advisedGroupIds: [], advisedCohortIds: [] }
  const item = (audienceKind: AudienceKind, status: ItemStatus = 'published', everPublished = status !== 'draft') => ({
    status,
    audienceKind,
    cohortId: COHORT,
    groupIds: [G1],
    receiverUnit: 'none' as const,
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

  it('已刪除（CL-14）：原本看得到的人看到「已刪除」；看不到的人跟還在時一樣（找不到或先登入），分不出被刪了', () => {
    const gone = (audienceKind: AudienceKind, status: ItemStatus = 'archived', everPublished = true) => ({
      ...item(audienceKind, status, everPublished),
      deleted: true,
    })
    expect(publicAccessOf(anonymous, gone('public'))).toBe('deleted')
    expect(publicAccessOf(admin, gone('public'))).toBe('deleted')
    expect(publicAccessOf(student(), gone('cohort_students'))).toBe('deleted')
    expect(publicAccessOf(student(COHORT, [G1]), gone('groups', 'draft', true))).toBe('deleted')
    // 看不到的人：結果跟同一則還在時一樣。
    expect(publicAccessOf(student(OTHER), gone('cohort_students'))).toBe('not_found')
    expect(publicAccessOf(student(COHORT, []), gone('groups'))).toBe('not_found')
    expect(publicAccessOf(anonymous, gone('cohort_students'))).toBe('need_login')
    expect(publicAccessOf(anonymous, gone('cohort_students'))).toBe(publicAccessOf(anonymous, item('cohort_students', 'archived')))
    // 從沒發布過就刪掉的草稿：連管理員都是找不到。
    expect(publicAccessOf(admin, gone('public', 'draft', false))).toBe('not_found')
    expect(publicAccessOf(anonymous, gone('public', 'draft', false))).toBe('not_found')
  })
})
