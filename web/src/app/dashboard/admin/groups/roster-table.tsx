'use client'
import { useState, type ReactNode } from 'react'
import { IconCopy, IconDownload } from '@tabler/icons-react'
import { BulkBar, DataTableFrame, DT, EmptyRow, SortLink } from '@/app/_ui/data-table'
import { ALERT, BTN_ROW, BTN_ROW_GHOST, NOTE } from '@/app/_ui/dashboard/look'
import { cn } from '@/shared/cn'

const SECONDARY_SM = BTN_ROW
const GHOST_SM = BTN_ROW_GHOST

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
    <div className="relative">
      <button
        type="button"
        className={cn(GHOST_SM, 'px-1.5')}
        title="複製本組信箱"
        aria-label={`複製本組信箱：${code}`}
        onClick={async () => {
          const ok = await copyText(joined)
          setMessage(
            ok
              ? { ok: true, text: `已複製 ${emails.length} 個信箱，可以直接貼到收件人欄。` }
              : { ok: false, text: '瀏覽器不允許複製，請手動選取旁邊的信箱。' },
          )
          // 提示浮在表格上，成功的過幾秒自己收起來；失敗的留著，讓人照著做。
          if (ok) setTimeout(() => setMessage(null), 5000)
        }}
      >
        <IconCopy className="size-3.5" aria-hidden />
      </button>
      {message ? (
        <p role="status" className={cn('absolute top-full right-0 z-10 mt-1 w-56 rounded-lg bg-popover p-2 text-xs shadow-md ring-1 ring-foreground/10', message.ok ? 'text-brand-on-subtle' : 'text-destructive')}>
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

  const exportButton = (label: string, format: 'csv' | 'xlsx', scope: 'ids' | 'filter', disabled: boolean) => (
    <button type="button" className={SECONDARY_SM} disabled={busy || disabled} onClick={() => exportRoster(format, scope)}>
      <IconDownload className="size-3.5" aria-hidden />
      {label}
    </button>
  )

  return (
    <div className="space-y-3">
      {/* 批次動作列（原型：有勾選才出現，橘色細框）：匯出勾選的組別。 */}
      {visibleSelected.length > 0 ? (
        <BulkBar>
          <span className="tabular text-sm font-medium">已選 {visibleSelected.length} 組</span>
          <span className="text-xs text-muted-foreground">（目前篩選結果共 {rows.length} 組）</span>
          <div className="ml-auto flex flex-wrap gap-2">
            {exportButton('匯出勾選（CSV）', 'csv', 'ids', false)}
            {exportButton('匯出勾選（XLSX）', 'xlsx', 'ids', false)}
            <button type="button" className={GHOST_SM} onClick={() => setSelected(new Set())}>
              取消選取
            </button>
          </div>
        </BulkBar>
      ) : null}
      {message ? (
        <p role={message.tone === 'ok' ? 'status' : 'alert'} className={message.tone === 'ok' ? NOTE : ALERT}>
          {message.text}
        </p>
      ) : null}
      <DataTableFrame>
        <table className={`${DT.table} min-w-[64rem]`}>
          <thead className={DT.thead}>
            <tr>
              <th scope="col" className={`${DT.th} w-10`}>
                <input
                  type="checkbox"
                  className="size-4 accent-brand align-middle"
                  aria-label="全選目前顯示的組別"
                  checked={allChecked}
                  onChange={(e) => setSelected(e.target.checked ? new Set([...selected, ...ids]) : new Set([...selected].filter((id) => !ids.includes(id))))}
                />
              </th>
              {columns.map((c) => (
                <th
                  key={c.label || 'actions'}
                  scope="col"
                  className={DT.th}
                  aria-sort={c.active === 'asc' ? 'ascending' : c.active === 'desc' ? 'descending' : undefined}
                >
                  {c.sortHref ? <SortLink label={c.label} href={c.sortHref} active={c.active ?? null} /> : c.label}
                </th>
              ))}
              <th scope="col" className={DT.th}>
                組員信箱
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <EmptyRow colSpan={columns.length + 2} title={empty} />
            ) : (
              rows.map((row) => (
                <tr
                  key={row.id}
                  className={`${DT.tr} align-top`}
                  data-testid="roster-row"
                  data-code={row.code}
                  data-state={selected.has(row.id) ? 'selected' : undefined}
                >
                  <td className={DT.td}>
                    <input
                      type="checkbox"
                      className="size-4 accent-brand align-middle"
                      aria-label={`勾選 ${row.code}`}
                      checked={selected.has(row.id)}
                      onChange={(e) => toggle(row.id, e.target.checked)}
                    />
                  </td>
                  {row.cells.map((cell, index) => (
                    <td key={index} className={DT.td}>
                      {cell}
                    </td>
                  ))}
                  <td className={DT.td}>
                    {/* 原型的列是單行：信箱排成一行、太長就截斷（滑過看全部），旁邊一顆複製鈕。 */}
                    <div className="flex items-center gap-1">
                      <ul
                        aria-label={`${row.code} 組員信箱`}
                        title={row.emails.join(', ')}
                        className="max-w-[13rem] truncate text-xs text-muted-foreground [&>li]:inline [&>li+li]:before:content-['、']"
                      >
                        {row.emails.map((email) => (
                          <li key={email}>{email}</li>
                        ))}
                      </ul>
                      <CopyEmailsButton code={row.code} emails={row.emails} />
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </DataTableFrame>
      {/* 表格底部（原型：左「共 N 筆」）；匯出整份篩選結果放右邊。 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="tabular text-xs text-muted-foreground" data-testid="roster-count">
          顯示 {rows.length}／{total} 組・已勾選 {visibleSelected.length} 組
        </p>
        <div className="flex flex-wrap gap-2">
          {exportButton('匯出篩選結果（CSV）', 'csv', 'filter', rows.length === 0)}
          {exportButton('匯出篩選結果（XLSX）', 'xlsx', 'filter', rows.length === 0)}
        </div>
      </div>
    </div>
  )
}
