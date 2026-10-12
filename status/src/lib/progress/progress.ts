/**
 * 開發進度頁（設計方案 §3.10、§3.4a）：票清單依批次分區，跟 GitHub 的 PR 比對。
 *
 * 「對不上」只是提醒主腦更新票清單，不自動改檔：
 * GitHub 已合併但票不是 `merged`，或票寫 `merged` 但 PR 沒合併。
 */
import {
  TICKET_STATUSES,
  TICKET_STATUS_LABEL,
  type GithubData,
  type PullRequestInfo,
  type Ticket,
  type TicketStatus,
  type TicketsFile,
} from '@/lib/data/types'

export const REPO_URL = 'https://github.com/roy4222/fju-im-project'
export const MISMATCH_TEXT = '票清單跟 GitHub 對不上'

export type PrState = 'merged' | 'open' | 'closed' | 'unknown'

export type TicketRow = {
  ticket: Ticket
  statusLabel: string
  pr: { number: number; url: string; state: PrState; label: string } | null
  /** 票清單跟 GitHub 對不上 → 標黃 */
  mismatch: string | null
}

export type BatchSection = { id: string; name: string; plan: string | null; rows: TicketRow[] }

export type ProgressView = {
  sections: BatchSection[]
  counts: { status: TicketStatus; label: string; count: number }[]
  total: number
  updatedAt: string | null
  sourceSha: string | null
  recentMerged: PullRequestInfo[]
}

const PR_LABEL: Record<PrState, string> = {
  merged: '已合併',
  open: '開著',
  closed: '關掉沒合併',
  unknown: '最近 100 筆找不到這個 PR',
}

function prState(pr: PullRequestInfo | undefined): PrState {
  if (!pr) return 'unknown'
  if (pr.merged) return 'merged'
  return pr.state === 'open' ? 'open' : 'closed'
}

/** 票清單跟 GitHub 對不上的原因；對得上或無從比對（沒 PR、PR 不在最近 100 筆）是 null。 */
export function ticketMismatch(ticket: Ticket, pr: PullRequestInfo | undefined): string | null {
  if (ticket.pr === null || ticket.pr === undefined || !pr) return null
  if (pr.merged && ticket.status !== 'merged') return `${MISMATCH_TEXT}：PR #${pr.number} 已合併，票清單寫「${labelOf(ticket.status)}」`
  if (!pr.merged && ticket.status === 'merged') return `${MISMATCH_TEXT}：票清單寫「已合併」，PR #${pr.number} 沒合併`
  return null
}

function labelOf(status: string): string {
  return (TICKET_STATUS_LABEL as Record<string, string>)[status] ?? status
}

export function buildProgress(tickets: (TicketsFile & { sourceSha?: string }) | null, github: GithubData | null): ProgressView {
  const prs = new Map((github?.prs ?? []).map((p) => [p.number, p]))
  const list = Array.isArray(tickets?.tickets) ? tickets.tickets : []
  const batches = Array.isArray(tickets?.batches) ? tickets.batches : []

  const toRow = (t: Ticket): TicketRow => {
    const pr = typeof t.pr === 'number' ? prs.get(t.pr) : undefined
    const state = prState(pr)
    return {
      ticket: t,
      statusLabel: labelOf(t.status),
      pr: typeof t.pr === 'number' ? { number: t.pr, url: pr?.url ?? `${REPO_URL}/pull/${t.pr}`, state, label: PR_LABEL[state] } : null,
      mismatch: ticketMismatch(t, pr),
    }
  }

  const sections: BatchSection[] = batches.map((b) => ({
    id: b.id,
    name: b.name,
    plan: b.plan ?? null,
    rows: list.filter((t) => t.batch === b.id).map(toRow),
  }))
  const known = new Set(batches.map((b) => b.id))
  const orphans = list.filter((t) => !known.has(t.batch))
  if (orphans.length) sections.push({ id: '_other', name: '其他（批次不在清單裡）', plan: null, rows: orphans.map(toRow) })

  const counts = TICKET_STATUSES.map((status) => ({
    status,
    label: TICKET_STATUS_LABEL[status],
    count: list.filter((t) => t.status === status).length,
  }))

  const recentMerged = (github?.prs ?? [])
    .filter((p) => p.merged)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 5)

  return {
    sections,
    counts,
    total: list.length,
    updatedAt: tickets?.updatedAt ?? null,
    sourceSha: tickets?.sourceSha ?? null,
    recentMerged,
  }
}
