'use client'
import Link from 'next/link'
import { useState, type ReactNode } from 'react'
import { cn } from '@/shared/cn'
import { SECONDARY } from './admin-group-forms'

/**
 * 分組總覽的組別名單（票 20；原型 `/dashboard/admin/groups` 的 Data Table；#96、#105、執行手冊 C18）。
 *
 * 篩選與排序在網址上、由伺服器算（見 page.tsx）；這個元件只管勾選、「複製本組信箱」與匯出。
 * 匯出兩種範圍：「勾選的組別」與「目前篩選的全部結果」。兩種都由伺服器重新授權、重新查詢，不信瀏覽器手上的列。
 * 信箱是帳號的登入信箱（不限 gmail.com），頁面只在管理員的查詢裡拿得到。
 */

export type RosterColumn = { readonly label: string; readonly sortHref?: string; readonly active?: 'asc' | 'desc' | null }

export type RosterRow = {
  readonly id: string
  readonly code: string
  /** 組員登入信箱（組長在前）。 */
  readonly emails: readonly string[]
  /** 其他欄位（伺服器端組好的內容，可能含指派、詳情等按鈕）。 */
  readonly cells: readonly ReactNode[]
}

/** 把字串放進剪貼簿。`navigator.clipboard` 不能用時（非安全來源、權限被擋）退回選取文字＋複製指令。 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 往下走後備做法。
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  }
  area.remove()
  return copied
}

export function CopyEmailsButton({ code, emails }: { code: string; emails: readonly string[] }) {
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  if (emails.length === 0) return <span className="text-xs text-muted-foreground">沒有信箱</span>
  const joined = emails.join(', ')
  return (
    <div className="space-y-1">
      <button
        type="button"
        className={SECONDARY}
        aria-label={`複製本組信箱：${code}`}
        onClick={async () => {
          const ok = await copyText(joined)
          setMessage(
            ok
              ? { ok: true, text: `已複製 ${emails.length} 個信箱，可以直接貼到收件人欄。` }
              : { ok: false, text: '瀏覽器不允許複製，請手動選取上面的信箱。' },
          )
        }}
      >
        複製本組信箱
      </button>
      {message ? (
        <p role="status" className={cn('text-xs', message.ok ? 'text-primary-on-subtle' : 'text-danger')}>
          {message.text}
        </p>
      ) : null}
    </div>
  )
}

export function GroupRosterTable({
  cohortId,
  columns,
  rows,
  filter,
  total,
  empty,
}: {
  cohortId: string
  columns: readonly RosterColumn[]
  rows: readonly RosterRow[]
  /** 目前的篩選（匯出「篩選結果」時原樣送回伺服器重算）。 */
  filter: Record<string, string>
  /** 這一屆全部組別數（篩選前）。 */
  total: number
  empty: string
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'error' | 'ok'; text: string } | null>(null)
  const ids = rows.map((r) => r.id)
  // 篩選換了之後，不在畫面上的組別不算勾選（避免匯出看不到的組）。
  const visibleSelected = ids.filter((id) => selected.has(id))
  const allChecked = ids.length > 0 && visibleSelected.length === ids.length

  function toggle(id: string, on: boolean) {
    const next = new Set(selected)
    if (on) next.add(id)
    else next.delete(id)
    setSelected(next)
  }

  async function exportRoster(format: 'csv' | 'xlsx', scope: 'ids' | 'filter') {
    setBusy(true)
    setMessage(null)
    try {
      const body =
        scope === 'ids' ? { cohortId, format, kind: 'ids', groupIds: visibleSelected } : { cohortId, format, kind: 'filter', filter }
      const response = await fetch('/api/admin/groups/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as { message?: string } | null
        setMessage({ tone: 'error', text: problem?.message ?? '匯出失敗，請重新整理頁面再試。' })
        return
      }
      const disposition = response.headers.get('content-disposition') ?? ''
      const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1]
      const fileName = encoded ? decodeURIComponent(encoded) : `組別名單.${format}`
      const url = URL.createObjectURL(await response.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      setMessage({
        tone: 'ok',
        text: `已匯出 ${response.headers.get('x-export-count') ?? ''} 組、${response.headers.get('x-export-rows') ?? ''} 位組員（${fileName}）。`,
      })
    } catch {
      setMessage({ tone: 'error', text: '匯出失敗，請檢查網路後再試。' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-border bg-background px-3 py-2">
        <p className="text-sm text-muted-foreground tabular-nums" data-testid="roster-count">
          顯示 {rows.length}／{total} 組・已勾選 {visibleSelected.length} 組
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={SECONDARY} disabled={busy || visibleSelected.length === 0} onClick={() => exportRoster('csv', 'ids')}>
            匯出勾選（CSV）
          </button>
          <button type="button" className={SECONDARY} disabled={busy || visibleSelected.length === 0} onClick={() => exportRoster('xlsx', 'ids')}>
            匯出勾選（XLSX）
          </button>
          <button type="button" className={SECONDARY} disabled={busy || rows.length === 0} onClick={() => exportRoster('csv', 'filter')}>
            匯出篩選結果（CSV）
          </button>
          <button type="button" className={SECONDARY} disabled={busy || rows.length === 0} onClick={() => exportRoster('xlsx', 'filter')}>
            匯出篩選結果（XLSX）
          </button>
        </div>
      </div>
      {message ? (
        <p
          role={message.tone === 'ok' ? 'status' : 'alert'}
          className={cn(
            'rounded-md px-3 py-2 text-sm',
            message.tone === 'ok' ? 'bg-primary-subtle text-primary-on-subtle' : 'bg-danger-subtle text-danger-on-subtle',
          )}
        >
          {message.text}
        </p>
      ) : null}
      <div className="overflow-x-auto rounded-card border border-border">
        <table className="w-full min-w-[56rem] border-collapse text-sm">
          <thead className="bg-muted text-left text-muted-foreground">
            <tr>
              <th scope="col" className="w-10 px-3 py-2">
                <input
                  type="checkbox"
                  aria-label="全選目前顯示的組別"
                  checked={allChecked}
                  onChange={(e) => setSelected(e.target.checked ? new Set([...selected, ...ids]) : new Set([...selected].filter((id) => !ids.includes(id))))}
                />
              </th>
              {columns.map((c) => (
                <th key={c.label} scope="col" className="px-3 py-2 font-medium" aria-sort={c.active === 'asc' ? 'ascending' : c.active === 'desc' ? 'descending' : undefined}>
                  {c.sortHref ? (
                    <Link href={c.sortHref} className="inline-flex items-center gap-1 hover:text-ink">
                      {c.label}
                      <span aria-hidden className="text-xs">
                        {c.active === 'asc' ? '▲' : c.active === 'desc' ? '▼' : '↕'}
                      </span>
                    </Link>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
              <th scope="col" className="px-3 py-2 font-medium">
                組員信箱
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length + 2} className="px-4 py-8 text-center text-muted-foreground">
                  {empty}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id} className="border-t border-border align-top" data-testid="roster-row" data-code={row.code}>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label={`勾選 ${row.code}`}
                      checked={selected.has(row.id)}
                      onChange={(e) => toggle(row.id, e.target.checked)}
                    />
                  </td>
                  {row.cells.map((cell, index) => (
                    <td key={index} className="px-3 py-2">
                      {cell}
                    </td>
                  ))}
                  <td className="px-3 py-2">
                    <ul aria-label={`${row.code} 組員信箱`} className="mb-2 space-y-0.5 text-xs text-ink">
                      {row.emails.map((email) => (
                        <li key={email} className="break-all">
                          {email}
                        </li>
                      ))}
                    </ul>
                    <CopyEmailsButton code={row.code} emails={row.emails} />
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
