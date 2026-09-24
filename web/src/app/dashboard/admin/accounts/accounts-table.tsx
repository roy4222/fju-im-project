'use client'
import { useState } from 'react'
import Link from 'next/link'
import type { AccountRow, AccountStatus, DirectoryFilter, DirectorySort, Role } from '@/application/accounts'
import { cn } from '@/shared/cn'
import { BulkDisableDialog } from './bulk-disable-dialog'
import { StatusDialog } from './status-dialog'

/**
 * 帳號表格（票 9；原型 `/dashboard/admin/accounts` 的 AccountsTable）。
 *
 * 篩選、排序、分頁都在網址上、由伺服器算（見 page.tsx）；這個元件只管勾選與匯出。
 * 匯出有兩種範圍：「勾選的人」與「目前篩選的全部結果」（不限目前這一頁）。
 * 兩種都由伺服器重新授權、重新查詢，不信瀏覽器手上的列。
 */

const BUTTON =
  'inline-flex items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50'
const PRIMARY = 'bg-primary text-primary-foreground hover:bg-primary/90'
const SECONDARY = 'bg-muted text-foreground hover:bg-border'

export type SortHeader = { readonly href: string; readonly active: 'asc' | 'desc' | null }

export type AccountsTableProps = {
  readonly rows: readonly AccountRow[]
  readonly total: number
  readonly filter: DirectoryFilter
  readonly currentUserId: string
  readonly statusLabel: Record<AccountStatus, string>
  readonly roleLabel: Record<Role, string>
  readonly sortHeaders: Record<DirectorySort, SortHeader>
  readonly bulkMaxChars: number
}

const STATUS_TONE: Record<AccountStatus, string> = {
  pending: 'bg-primary-subtle text-primary-on-subtle',
  active: 'bg-muted text-ink',
  disabled: 'bg-danger-subtle text-danger-on-subtle',
  deidentified: 'bg-muted text-muted-foreground',
}

export function AccountsTable(props: AccountsTableProps) {
  const { rows, total, filter, currentUserId, statusLabel, roleLabel, sortHeaders } = props
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'error' | 'ok'; text: string } | null>(null)

  const pageIds = rows.map((r) => r.userId)
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id))
  const someOnPage = pageIds.some((id) => selected.has(id))

  function toggle(id: string, on: boolean) {
    const next = new Set(selected)
    if (on) next.add(id)
    else next.delete(id)
    setSelected(next)
  }

  function togglePage(on: boolean) {
    const next = new Set(selected)
    for (const id of pageIds) {
      if (on) next.add(id)
      else next.delete(id)
    }
    setSelected(next)
  }

  async function exportCsv(body: unknown) {
    setBusy(true)
    setMessage(null)
    try {
      const response = await fetch('/api/admin/accounts/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        const failure = (await response.json().catch(() => null)) as { message?: string } | null
        setMessage({ tone: 'error', text: failure?.message ?? '匯出失敗，請重新整理頁面再試。' })
        return
      }
      const count = response.headers.get('x-export-count')
      const disposition = response.headers.get('content-disposition') ?? ''
      const encoded = /filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1]
      const fileName = encoded ? decodeURIComponent(encoded) : '帳號名單.csv'
      const url = URL.createObjectURL(await response.blob())
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = fileName
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      setMessage({ tone: 'ok', text: `已匯出 ${count ?? ''} 筆（${fileName}）。` })
    } catch {
      setMessage({ tone: 'error', text: '匯出失敗，請檢查網路後再試。' })
    } finally {
      setBusy(false)
    }
  }

  function header(label: string, sort?: DirectorySort) {
    if (!sort) return label
    const h = sortHeaders[sort]
    return (
      <Link href={h.href} className="inline-flex items-center gap-1 hover:text-ink" aria-label={`依${label}排序`}>
        {label}
        <span aria-hidden="true" className={h.active ? 'text-ink' : 'text-border'}>
          {h.active === 'asc' ? '▲' : '▼'}
        </span>
      </Link>
    )
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2" role="toolbar" aria-label="批次動作">
        <span className="text-sm text-muted-foreground" data-testid="selected-count">
          已勾選 {selected.size} 筆
        </span>
        <button
          type="button"
          className={cn(BUTTON, PRIMARY)}
          disabled={busy || selected.size === 0}
          onClick={() => exportCsv({ kind: 'ids', userIds: [...selected] })}
        >
          匯出勾選的 CSV
        </button>
        <button
          type="button"
          className={cn(BUTTON, SECONDARY)}
          disabled={busy || total === 0}
          onClick={() => exportCsv({ kind: 'filter', filter: filterParams(filter) })}
        >
          匯出全部篩選結果（{total} 筆）
        </button>
        {selected.size > 0 ? (
          <button type="button" className={cn(BUTTON, SECONDARY)} onClick={() => setSelected(new Set())}>
            清除勾選
          </button>
        ) : null}
        <span className="ml-auto">
          <BulkDisableDialog maxChars={props.bulkMaxChars} />
        </span>
      </div>
      {message ? (
        <p
          role={message.tone === 'error' ? 'alert' : 'status'}
          className={cn(
            'mb-3 rounded-md px-3 py-2 text-sm',
            message.tone === 'error' ? 'bg-danger-subtle text-danger-on-subtle' : 'bg-primary-subtle text-primary-on-subtle',
          )}
        >
          {message.text}
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-card border border-border">
        <table className="w-full min-w-[56rem] border-collapse text-sm" aria-label="帳號列表">
          <thead className="bg-muted text-left text-muted-foreground">
            <tr>
              <th scope="col" className="w-10 px-3 py-2">
                <input
                  type="checkbox"
                  aria-label="全選本頁"
                  checked={allOnPage}
                  ref={(el) => {
                    if (el) el.indeterminate = someOnPage && !allOnPage
                  }}
                  onChange={(e) => togglePage(e.target.checked)}
                />
              </th>
              <th scope="col" className="px-3 py-2 font-medium">{header('姓名')}</th>
              <th scope="col" className="px-3 py-2 font-medium">{header('學號', 'studentNo')}</th>
              <th scope="col" className="px-3 py-2 font-medium">{header('系級')}</th>
              <th scope="col" className="px-3 py-2 font-medium">{header('屆別', 'cohort')}</th>
              <th scope="col" className="px-3 py-2 font-medium">{header('Email')}</th>
              <th scope="col" className="px-3 py-2 font-medium">{header('角色')}</th>
              <th scope="col" className="px-3 py-2 font-medium">{header('狀態', 'status')}</th>
              <th scope="col" className="px-3 py-2 font-medium">{header('建立', 'createdAt')}</th>
              <th scope="col" className="px-3 py-2 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-4 py-8 text-center text-muted-foreground">
                  沒有符合條件的帳號。試著清除篩選或換個關鍵字。
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.userId} className="border-t border-border" data-user-id={r.userId}>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label={`選取 ${r.name}`}
                      checked={selected.has(r.userId)}
                      onChange={(e) => toggle(r.userId, e.target.checked)}
                    />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-medium text-ink">{r.name}</td>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums">{r.studentNo ?? '—'}</td>
                  <td className="whitespace-nowrap px-3 py-2">{r.departmentClass || '—'}</td>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums">{r.cohortCode ?? '—'}</td>
                  <td className="max-w-[16rem] truncate px-3 py-2 text-muted-foreground" title={r.loginEmail}>
                    {r.loginEmail}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {r.roles.length > 0 ? r.roles.map((role) => roleLabel[role]).join('、') : '—'}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <span className={cn('rounded-full px-2 py-0.5 text-xs', STATUS_TONE[r.status])}>{statusLabel[r.status]}</span>
                    {r.status === 'pending' && r.applicationState === 'rejected' ? (
                      <span className="ml-1 text-xs text-muted-foreground">已退回</span>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums text-muted-foreground">
                    {r.createdAt.slice(0, 10)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {(r.status === 'active' || r.status === 'disabled') && r.userId !== currentUserId ? (
                      <StatusDialog
                        account={{
                          userId: r.userId,
                          name: r.name,
                          loginEmail: r.loginEmail,
                          studentNo: r.studentNo,
                          status: r.status,
                        }}
                      />
                    ) : r.status === 'pending' && r.applicationState === 'pending' ? (
                      <span className="text-xs text-muted-foreground">在上方待審核清單審核</span>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** 匯出「目前篩選」時送回伺服器的條件（與網址參數同名）。 */
function filterParams(filter: DirectoryFilter): Record<string, string> {
  const params: Record<string, string> = { sort: filter.sort, dir: filter.dir }
  if (filter.q) params.q = filter.q
  if (filter.role) params.role = filter.role
  if (filter.cohortId) params.cohort = filter.cohortId
  if (filter.status) params.status = filter.status
  return params
}
