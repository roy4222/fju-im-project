// 開發進度：票清單對不上判定與分區（設計方案 §3.4a、§3.10、AC-S-13）。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import type { GithubData, PullRequestInfo, Ticket, TicketsFile } from '@/lib/data/types'

import { MISMATCH_TEXT, buildProgress, ticketMismatch } from './progress'

const dir = path.join(import.meta.dirname, '..', '..', '..', 'fixtures', 'progress', 'data')
const load = <T,>(f: string) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as T
const tickets = load<TicketsFile & { sourceSha: string }>('repo/tickets.json')
const github = load<GithubData>('github.json')

const ticket = (over: Partial<Ticket>): Ticket => ({
  id: 'X-1', batch: 's', title: 't', wave: '第一波', status: 'doing', owner: 'Opus', branch: 'b', pr: 1,
  dependsOn: [], acceptance: [], note: '', ...over,
})
const pr = (over: Partial<PullRequestInfo>): PullRequestInfo => ({
  number: 1, state: 'closed', merged: true, headRef: 'b', url: 'https://example.test/pull/1', updatedAt: '2026-10-12T00:00:00Z', ...over,
})

describe('ticketMismatch', () => {
  it('GitHub 已合併但票不是 merged → 對不上', () => {
    expect(ticketMismatch(ticket({ status: 'doing' }), pr({ merged: true }))).toContain(MISMATCH_TEXT)
  })
  it('票寫 merged 但 PR 沒合併 → 對不上', () => {
    expect(ticketMismatch(ticket({ status: 'merged' }), pr({ merged: false, state: 'open' }))).toContain(MISMATCH_TEXT)
  })
  it('對得上、沒有 PR、PR 不在最近 100 筆 → 不標', () => {
    expect(ticketMismatch(ticket({ status: 'merged' }), pr({ merged: true }))).toBeNull()
    expect(ticketMismatch(ticket({ status: 'review' }), pr({ merged: false, state: 'open' }))).toBeNull()
    expect(ticketMismatch(ticket({ pr: null }), undefined)).toBeNull()
    expect(ticketMismatch(ticket({ status: 'doing' }), undefined)).toBeNull()
  })
})

describe('buildProgress（AC-S-13 的 fixtures）', () => {
  const view = buildProgress(tickets, github)

  it('依批次分區，4 張票都在', () => {
    expect(view.sections.map((s) => [s.id, s.rows.map((r) => r.ticket.id)])).toEqual([
      ['p1', ['P1-T1', 'P1-T13']],
      ['s', ['S-1', 'S-6']],
    ])
    expect(view.total).toBe(4)
  })

  it('只有 P1-T13 對不上', () => {
    const flagged = view.sections.flatMap((s) => s.rows).filter((r) => r.mismatch)
    expect(flagged.map((r) => r.ticket.id)).toEqual(['P1-T13'])
  })

  it('各狀態張數、sourceSha、狀態中文', () => {
    const count = Object.fromEntries(view.counts.map((c) => [c.status, c.count]))
    expect(count).toMatchObject({ merged: 2, doing: 1, todo: 1, review: 0 })
    expect(view.sourceSha).toBe(tickets.sourceSha)
    expect(view.sections[0]!.rows[1]!.statusLabel).toBe('做中')
  })

  it('PR 不在最近 100 筆 → 顯示「找不到」不標黃', () => {
    const row = buildProgress(
      { ...tickets, tickets: [ticket({ batch: 'p1', pr: 999 })] },
      github,
    ).sections[0]!.rows[0]!
    expect(row.pr?.label).toContain('找不到')
    expect(row.mismatch).toBeNull()
  })

  it('批次不在清單裡的票放「其他」，不會消失', () => {
    const v = buildProgress({ ...tickets, tickets: [ticket({ batch: 'zz' })] }, github)
    expect(v.sections.at(-1)!.rows.map((r) => r.ticket.id)).toEqual(['X-1'])
  })

  it('最近合併的 PR 最多 5 筆、新到舊', () => {
    expect(view.recentMerged.map((p) => p.number)).toEqual([348, 345, 344, 343, 342])
  })

  it('沒有資料也不壞', () => {
    expect(buildProgress(null, null)).toMatchObject({ sections: [], total: 0, sourceSha: null, recentMerged: [] })
  })
})
