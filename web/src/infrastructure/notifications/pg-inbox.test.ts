import { describe, expect, it } from 'vitest'
import { resolveSource } from '@/infrastructure/notifications/pg-inbox'

/** 票 18：專題事務的通知依「現在」的項目與本人身分給連結（票 16 遺留）。 */

const ID = '0192d6a0-0000-7000-8000-000000000001'
const row = (patch: Record<string, unknown>) => ({
  source_ref: { type: 'item', id: ID },
  cohort_status: 'active',
  item_placement: 'submission',
  item_status: 'published',
  item_receiver_unit: 'individual',
  item_on_roster: true,
  ...patch,
})

describe('專題事務通知的連結', () => {
  it('收件：本人（整組一份：本人此刻的組）還在名單上 → 作業區那一份；被移出 → 不給連結', () => {
    expect(resolveSource(row({}))).toEqual({ state: 'ok', href: `/dashboard/student/affairs/${ID}` })
    expect(resolveSource(row({ item_on_roster: false }))).toEqual({ state: 'ok', href: null })
    // 票 21：組別收件（例如「組員已正式送出」的通知）連到作業區那一份。
    expect(resolveSource(row({ item_receiver_unit: 'group' }))).toEqual({ state: 'ok', href: `/dashboard/student/affairs/${ID}` })
    expect(resolveSource(row({ item_receiver_unit: 'group', item_on_roster: false }))).toEqual({ state: 'ok', href: null })
    expect(resolveSource(row({ item_receiver_unit: 'none' }))).toEqual({ state: 'ok', href: null })
  })

  it('公告 → 前台內容頁（下架、撤回也連，由那一頁告知下一步）；資源、規則 → 前台清單頁；其他種類不給', () => {
    expect(resolveSource(row({ item_placement: 'news', item_on_roster: false }))).toEqual({ state: 'ok', href: `/news/${ID}` })
    expect(resolveSource(row({ item_placement: 'news', item_status: 'archived' }))).toEqual({ state: 'ok', href: `/news/${ID}` })
    expect(resolveSource(row({ item_placement: 'resource' }))).toEqual({ state: 'ok', href: '/files' })
    expect(resolveSource(row({ item_placement: 'rules' }))).toEqual({ state: 'ok', href: '/rules' })
    expect(resolveSource(row({ item_placement: 'showcase' }))).toEqual({ state: 'ok', href: null })
  })

  it('收件不是發布中、項目不在了 → 不給連結；屆別封存照舊標唯讀', () => {
    expect(resolveSource(row({ item_status: 'archived' }))).toEqual({ state: 'ok', href: null })
    expect(resolveSource(row({ item_status: 'draft' }))).toEqual({ state: 'ok', href: null })
    expect(resolveSource(row({ item_status: null, item_placement: null }))).toEqual({ state: 'ok', href: null })
    expect(resolveSource(row({ cohort_status: 'archived' }))).toEqual({ state: 'archived', href: `/dashboard/student/affairs/${ID}` })
  })
})

describe('簽核版本通知的連結（2026-09-25 Roy 定：換掉的舊主指導失權含看不到）', () => {
  const signoff = (patch: Record<string, unknown>) => ({ source_ref: { type: 'signoff_version', id: ID }, cohort_status: 'active', ...patch })

  it('老師：此刻讀得到那一版 → 版本頁；讀不到（被換掉的舊主指導）→ 無法存取，不給連結', () => {
    expect(resolveSource(signoff({ signoff_readable: true }), ['teacher'])).toEqual({ state: 'ok', href: `/dashboard/teacher/signoff/${ID}` })
    expect(resolveSource(signoff({ signoff_readable: false }), ['teacher'])).toEqual({ state: 'forbidden' })
    expect(resolveSource(signoff({}), ['teacher'])).toEqual({ state: 'forbidden' })
  })

  it('學生進自己的簽核頁、管理員進管理版本頁（不看老師那一條）', () => {
    expect(resolveSource(signoff({ signoff_readable: false }), ['student'])).toEqual({ state: 'ok', href: '/dashboard/student/signoff' })
    expect(resolveSource(signoff({ signoff_readable: false }), ['admin'])).toEqual({ state: 'ok', href: `/dashboard/admin/signoff/${ID}` })
    expect(resolveSource(signoff({ signoff_readable: false }), ['teacher', 'admin'])).toEqual({ state: 'ok', href: `/dashboard/admin/signoff/${ID}` })
  })
})

describe('評分指派通知的連結（票 43：被移出後那一組不在評分清單就不給連結）', () => {
  const grading = (patch: Record<string, unknown>) => ({ source_ref: { type: 'grading_assignment', id: ID }, cohort_status: 'active', ...patch })

  it('老師：那一組還在本人的評分清單上 → 評分清單；已不在（被移出、改派走了）→ 不給連結，標題照樣看得到', () => {
    expect(resolveSource(grading({ grading_group_listed: true }), ['teacher'])).toEqual({ state: 'ok', href: '/dashboard/teacher/grading' })
    expect(resolveSource(grading({ grading_group_listed: false }), ['teacher'])).toEqual({ state: 'ok', href: null })
    expect(resolveSource(grading({}), ['teacher'])).toEqual({ state: 'ok', href: null })
  })

  it('不是老師：無法存取', () => {
    expect(resolveSource(grading({ grading_group_listed: true }), ['student'])).toEqual({ state: 'forbidden' })
  })
})
