import { describe, expect, it } from 'vitest'
import {
  checkDueWork,
  DomainEventRejected,
  DUE_WORK_KINDS,
  DueWorkRejected,
  EVENT_CATALOG,
  EVENT_CONSUMERS,
  normalizeDomainEvent,
  type DomainEventInput,
} from '@/application/notifications'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const COHORT = '33333333-3333-4333-8333-333333333333'
const SOURCE = '44444444-4444-4444-8444-444444444444'

const event = (patch: Partial<DomainEventInput> = {}): DomainEventInput => ({
  type: 'calendar.changed',
  scope: 'cohort',
  cohortId: COHORT,
  source: { type: 'project_event', id: SOURCE, version: 1 },
  actor: { kind: 'user', userId: A },
  recipients: [],
  occurredRealAt: new Date('2026-09-24T00:00:00Z'),
  occurredBusinessAt: new Date('2026-09-24T00:00:00Z'),
  ...patch,
})

describe('normalizeDomainEvent：收件人在寫入當下固定', () => {
  it('同一人重複出現只留一份，順序固定（排序）', () => {
    const normalized = normalizeDomainEvent(event({ recipients: [B, A, B, A.toUpperCase()] }))
    expect(normalized.recipients).toEqual([A, B])
  })

  it('消費者由事件目錄決定，不由呼叫端決定', () => {
    expect(normalizeDomainEvent(event()).consumers).toEqual(EVENT_CATALOG['calendar.changed'].consumers)
  })

  it('目錄裡的消費者都在 event_projections 的 CHECK 白名單內', () => {
    for (const { consumers } of Object.values(EVENT_CATALOG)) {
      for (const consumer of consumers) expect(EVENT_CONSUMERS).toContain(consumer)
    }
  })

  it('沒登記的事件型別：拒絕（程式寫錯，丟例外讓交易回滾）', () => {
    expect(() => normalizeDomainEvent(event({ type: 'nope.unknown' as never }))).toThrow(DomainEventRejected)
  })

  it('scope 與屆別要對得上（契約 01 §1）', () => {
    expect(() => normalizeDomainEvent(event({ scope: 'cohort', cohortId: null }))).toThrow(DomainEventRejected)
    expect(() => normalizeDomainEvent(event({ scope: 'global', cohortId: COHORT }))).toThrow(DomainEventRejected)
    expect(normalizeDomainEvent(event({ scope: 'global', cohortId: undefined })).cohortId).toBeNull()
  })

  it('收件人與來源 id 必須是 uuid', () => {
    expect(() => normalizeDomainEvent(event({ recipients: ['someone'] }))).toThrow(DomainEventRejected)
    expect(() => normalizeDomainEvent(event({ source: { type: 'x', id: 'nope' } }))).toThrow(DomainEventRejected)
  })
})

describe('checkDueWork：種類白名單', () => {
  const work = { kind: 'deadline_snapshot' as const, subject: { type: 'item', id: SOURCE }, deadlineVersion: 1 }

  it('白名單與 migration 的 CHECK 一致（改一邊要改另一邊）', () => {
    expect([...DUE_WORK_KINDS]).toEqual([
      'proposal_expiry',
      'deadline_snapshot',
      'snapshot_reconcile',
      'overdue_digest',
      'stage_end_unassigned',
      'file_gc',
      'receipt_purge',
      'test_noop',
    ])
  })

  it('白名單內：通過', () => {
    expect(() => checkDueWork(work, { testKindsEnabled: false })).not.toThrow()
  })

  it('未知種類：拒絕', () => {
    expect(() => checkDueWork({ ...work, kind: 'send_email' as never }, { testKindsEnabled: true })).toThrow(DueWorkRejected)
  })

  it('test_noop 只在測試站可以排；正式站拒絕', () => {
    const noop = { ...work, kind: 'test_noop' as const }
    expect(() => checkDueWork(noop, { testKindsEnabled: true })).not.toThrow()
    expect(() => checkDueWork(noop, { testKindsEnabled: false })).toThrow(/只能在測試站/)
  })

  it('版本要是 1 以上的整數、對象 id 要是 uuid', () => {
    expect(() => checkDueWork({ ...work, deadlineVersion: 0 }, { testKindsEnabled: false })).toThrow(DueWorkRejected)
    expect(() => checkDueWork({ ...work, deadlineVersion: 1.5 }, { testKindsEnabled: false })).toThrow(DueWorkRejected)
    expect(() => checkDueWork({ ...work, subject: { type: 'item', id: 'x' } }, { testKindsEnabled: false })).toThrow(DueWorkRejected)
  })
})
