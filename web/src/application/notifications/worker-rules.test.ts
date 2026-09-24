import { describe, expect, it } from 'vitest'
import {
  afterProjectionFailure,
  decodeInboxCursor,
  DomainEventRejected,
  DUE_WORK_WAIT_SECONDS,
  dueWorkTransition,
  encodeInboxCursor,
  EVENT_CATALOG,
  normalizeTestNotification,
  notificationPresentationOf,
  notificationsFor,
  parseInboxFilter,
  projectionBackoffSeconds,
  type ProjectableEvent,
} from '@/application/notifications'

/**
 * 票 12：背景工作與通知匣的純規則（投影、到期工作生命週期、通知匣篩選與游標）。
 */

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const EVENT = '33333333-3333-4333-8333-333333333333'
const SOURCE = '44444444-4444-4444-8444-444444444444'

const event = (patch: Partial<ProjectableEvent> = {}): ProjectableEvent => ({
  id: EVENT,
  type: 'test.notification',
  scope: 'global',
  cohortId: null,
  sourceType: 'test',
  sourceId: SOURCE,
  sourceVersion: 1,
  recipients: [A, B],
  payload: { title: '測試一下' },
  ...patch,
})

describe('notificationsFor：事件投影成通知', () => {
  it('每位收件人一則，收件人照事件固定的名單（去重）', () => {
    const drafts = notificationsFor(event({ recipients: [A, B, A.toUpperCase()] }))
    expect(drafts.map((d) => d.recipientUserId)).toEqual([A, B])
    expect(drafts[0]).toMatchObject({
      eventId: EVENT,
      kind: 'system',
      title: '測試一下',
      scope: 'global',
      cohortId: null,
      sourceRef: { type: 'test', id: SOURCE, version: 1 },
    })
  })

  it('沒帶標題用目錄的預設標題；過長的標題截短', () => {
    expect(notificationsFor(event({ payload: {} }))[0]!.title).toBe('測試通知')
    expect(notificationsFor(event({ payload: { title: '   ' } }))[0]!.title).toBe('測試通知')
    expect(notificationsFor(event({ payload: { title: 'x'.repeat(500) } }))[0]!.title.length).toBeLessThanOrEqual(120)
  })

  it('沒登記的型別、或登記了卻沒有通知樣子的型別：丟例外（毒事件，不默默跳過）', () => {
    expect(() => notificationsFor(event({ type: 'nope.unknown' }))).toThrow(DomainEventRejected)
    expect(() => notificationsFor(event({ type: 'calendar.changed' }))).toThrow(/沒有登記通知的樣子/)
  })

  it('目錄裡有 notifications 消費者的事件都要有通知的樣子', () => {
    for (const [type, entry] of Object.entries(EVENT_CATALOG)) {
      if ((entry.consumers as readonly string[]).includes('notifications')) {
        expect(notificationPresentationOf(type as keyof typeof EVENT_CATALOG), type).not.toBeNull()
      }
    }
  })
})

describe('投影失敗的退避與上限', () => {
  it('2^n 秒退避', () => {
    expect([0, 1, 2, 3, 4].map(projectionBackoffSeconds)).toEqual([1, 2, 4, 8, 16])
  })

  it('累計到第 5 次標 failed，之前維持 pending', () => {
    expect(afterProjectionFailure(0)).toEqual({ attempts: 1, state: 'pending' })
    expect(afterProjectionFailure(3)).toEqual({ attempts: 4, state: 'pending' })
    expect(afterProjectionFailure(4)).toEqual({ attempts: 5, state: 'failed' })
  })
})

describe('dueWorkTransition：到期工作生命週期（模組 08 §6 v2.4）', () => {
  const now = new Date('2026-09-24T00:00:00Z')

  it('成功：done，次數不變', () => {
    expect(dueWorkTransition({ kind: 'done', resultRef: { x: 1 } }, 2, now)).toEqual({
      state: 'done',
      attempts: 2,
      resultRef: { x: 1 },
    })
  })

  it('未註冊 handler 與 defer：保持 pending、5 分鐘後再看、次數不累計', () => {
    for (const kind of ['unregistered', 'defer'] as const) {
      expect(dueWorkTransition({ kind }, 3, now)).toEqual({
        state: 'pending',
        attempts: 3,
        nextAttemptAt: new Date(now.getTime() + DUE_WORK_WAIT_SECONDS * 1000),
      })
    }
  })

  it('handler 例外：次數 +1、退避 2^n 秒；第 5 次 failed', () => {
    expect(dueWorkTransition({ kind: 'error' }, 0, now)).toEqual({
      state: 'pending',
      attempts: 1,
      nextAttemptAt: new Date(now.getTime() + 2000),
    })
    expect(dueWorkTransition({ kind: 'error' }, 4, now)).toEqual({ state: 'failed', attempts: 5 })
  })
})

describe('通知匣：篩選、游標、測試通知輸入', () => {
  it('?cohort= 的值：global、uuid、其他一律當全部', () => {
    expect(parseInboxFilter('global')).toEqual({ kind: 'global' })
    expect(parseInboxFilter(A.toUpperCase())).toEqual({ kind: 'cohort', cohortId: A })
    expect(parseInboxFilter('drop table')).toEqual({ kind: 'all' })
    expect(parseInboxFilter(undefined)).toEqual({ kind: 'all' })
  })

  it('游標編碼後解得回來；壞掉的游標當作沒有', () => {
    const cursor = { createdAt: new Date('2026-09-24T01:02:03.456Z'), id: A }
    expect(decodeInboxCursor(encodeInboxCursor(cursor))).toEqual(cursor)
    expect(decodeInboxCursor('nope')).toBeNull()
    expect(decodeInboxCursor('2026-09-24T00:00:00Z_not-a-uuid')).toBeNull()
  })

  it('測試通知：要選收件人；標題空白用預設、太長擋下；屆別可空', () => {
    expect(normalizeTestNotification({ recipientUserId: '', cohortId: '', title: '' }).ok).toBe(false)
    expect(normalizeTestNotification({ recipientUserId: A, cohortId: '', title: '  ' })).toEqual({
      ok: true,
      value: { recipientUserId: A, cohortId: null, title: '測試通知' },
    })
    expect(normalizeTestNotification({ recipientUserId: A, cohortId: 'x', title: '' }).ok).toBe(false)
    expect(normalizeTestNotification({ recipientUserId: A, cohortId: B, title: 'y'.repeat(61) }).ok).toBe(false)
  })
})
