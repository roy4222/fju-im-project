'use client'
import { useState, type ReactNode } from 'react'
import { IconDownload } from '@tabler/icons-react'
import { BulkBar, DataTableFrame, DataTableToolbar, DT, EmptyRow, SortLink } from '@/app/_ui/data-table'
import { Pill } from '@/app/_ui/dashboard/primitives'
import type { AccountRow, AccountStatus, DirectoryFilter, DirectorySort, Role } from '@/application/accounts'
import { cn } from '@/shared/cn'
import { BulkDisableDialog } from './bulk-disable-dialog'
import { AdminRoleDialog, OrphanRepairDialog, type RoleTargetView } from './role-dialogs'
import { StatusDialog } from './status-dialog'
import { TemporaryPasswordDialog, type VerificationLabels } from './teacher-dialogs'

/**
 * 帳號表格（票 9；原型 `/dashboard/admin/accounts` 的 AccountsTable）。
 *
 * 篩選、排序、分頁都在網址上、由伺服器算（見 page.tsx）；這個元件只管勾選與匯出。
 * 匯出有兩種範圍：「勾選的人」與「目前篩選的全部結果」（不限目前這一頁）。
 * 兩種都由伺服器重新授權、重新查詢，不信瀏覽器手上的列。
 */

const BUTTON =
  // 外觀照原型（票 36）：h-10、圓角、粗一點的字；主要動作系網橘、次要白底細框、危險淡紅。
  'press inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4'
const SECONDARY = 'border border-border bg-background text-foreground hover:bg-muted'

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
  /** 票 8 的「發臨時密碼」對話框要用的核實方式標籤（app 對 application 只能帶型別，值由頁面傳進來）。 */
  readonly verificationLabels: VerificationLabels
  /** 工具列左邊（搜尋框與篩選鈕，伺服器組好傳進來）。 */
  readonly toolbar?: ReactNode
}

/** 原型：已核准綠、待審核中性（深字）、已停用灰。 */
const STATUS_TONE: Record<AccountStatus, 'success' | 'warning' | 'default'> = {
  pending: 'warning',
  active: 'success',
  disabled: 'default',
  deidentified: 'default',
}

export function AccountsTable(props: AccountsTableProps) {
  const { rows, total, filter, currentUserId, statusLabel, roleLabel, sortHeaders, toolbar } = props
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
    return <SortLink label={label} href={h.href} active={h.active} ariaLabel={`依${label}排序`} />
  }

  const ghost = 'h-7 border-transparent bg-transparent px-2.5 text-[0.8rem] font-medium hover:bg-muted'
  const small = 'h-7 px-2.5 text-[0.8rem] font-medium'

  return (
    <div className="space-y-3">
      {/* 原型 Data Table 的工具列：搜尋、篩選鈕（頁面給），右邊是整份匯出與批次停用。 */}
      <DataTableToolbar>
        {toolbar}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={cn(BUTTON, SECONDARY, 'h-9 px-3')}
            disabled={busy || total === 0}
            onClick={() => exportCsv({ kind: 'filter', filter: filterParams(filter) })}
          >
            <IconDownload aria-hidden />
            匯出全部篩選結果（{total} 筆）
          </button>
          <BulkDisableDialog maxChars={props.bulkMaxChars} />
        </span>
      </DataTableToolbar>

      {/* 批次動作列：只在有勾選時出現（原型：橘色細框、淡橘底）。 */}
      {selected.size > 0 ? (
        <BulkBar role="toolbar" aria-label="批次動作">
          <span className="tabular text-sm font-medium" data-testid="selected-count">
            已勾選 {selected.size} 筆
          </span>
          <span className="text-xs text-muted-foreground">（目前篩選結果共 {total} 筆）</span>
          <div className="ml-auto flex flex-wrap gap-2">
            <button
              type="button"
              className={cn(BUTTON, SECONDARY, small)}
              disabled={busy}
              onClick={() => exportCsv({ kind: 'ids', userIds: [...selected] })}
            >
              <IconDownload aria-hidden />
              匯出勾選的 CSV
            </button>
            <button type="button" className={cn(BUTTON, SECONDARY, ghost)} onClick={() => setSelected(new Set())}>
              清除勾選
            </button>
          </div>
        </BulkBar>
      ) : null}
      {message ? (
        <p
          role={message.tone === 'error' ? 'alert' : 'status'}
          className={cn(
            'rounded-lg px-3 py-2 text-sm',
            message.tone === 'error' ? 'bg-destructive-subtle text-destructive-on-subtle' : 'bg-brand-subtle text-brand-on-subtle',
          )}
        >
          {message.text}
        </p>
      ) : null}

      <DataTableFrame>
        <table className={cn(DT.table, 'min-w-[60rem]')} aria-label="帳號列表">
          <thead className={DT.thead}>
            <tr>
              <th scope="col" className={cn(DT.th, 'w-10')}>
                <input
                  type="checkbox"
                  className="size-4 align-middle accent-brand"
                  aria-label="全選本頁"
                  checked={allOnPage}
                  ref={(el) => {
                    if (el) el.indeterminate = someOnPage && !allOnPage
                  }}
                  onChange={(e) => togglePage(e.target.checked)}
                />
              </th>
              <th scope="col" className={DT.th}>{header('姓名')}</th>
              <th scope="col" className={DT.th}>{header('學號', 'studentNo')}</th>
              <th scope="col" className={DT.th}>{header('系級')}</th>
              <th scope="col" className={DT.th}>{header('屆別', 'cohort')}</th>
              <th scope="col" className={DT.th}>{header('Email')}</th>
              <th scope="col" className={DT.th}>{header('角色')}</th>
              <th scope="col" className={DT.th}>{header('狀態', 'status')}</th>
              <th scope="col" className={DT.th}>{header('建立', 'createdAt')}</th>
              <th scope="col" className={DT.th}>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <EmptyRow colSpan={10} title="沒有符合條件的帳號" hint="試著放寬搜尋字詞或清除篩選條件。" />
            ) : (
              rows.map((r) => (
                <tr key={r.userId} className={DT.tr} data-user-id={r.userId} data-state={selected.has(r.userId) ? 'selected' : undefined}>
                  <td className={DT.td}>
                    <input
                      type="checkbox"
                      className="size-4 align-middle accent-brand"
                      aria-label={`選取 ${r.name}`}
                      checked={selected.has(r.userId)}
                      onChange={(e) => toggle(r.userId, e.target.checked)}
                    />
                  </td>
                  {/* 頭像是原型的姓名首字圓圈；用偽元素畫，文字內容仍然只有姓名（表格搜尋與排序看的是這一格的字）。 */}
                  <td
                    className={cn(
                      DT.td,
                      'font-semibold whitespace-nowrap text-foreground',
                      "before:mr-2 before:inline-flex before:size-7 before:items-center before:justify-center before:rounded-full before:bg-brand-subtle before:align-middle before:text-[11px] before:font-bold before:text-brand-on-subtle before:content-[attr(data-initial)]",
                    )}
                    data-initial={r.name.slice(0, 1)}
                  >
                    {r.name}
                  </td>
                  <td className={cn(DT.td, 'tabular whitespace-nowrap')}>{r.studentNo ?? '—'}</td>
                  <td className={cn(DT.td, 'whitespace-nowrap')}>{r.departmentClass || '—'}</td>
                  <td className={cn(DT.td, 'tabular whitespace-nowrap')}>{r.cohortCode ?? '—'}</td>
                  <td className={cn(DT.td, 'max-w-[14rem] truncate text-muted-foreground')} title={r.loginEmail}>
                    {r.loginEmail}
                  </td>
                  <td className={cn(DT.td, 'whitespace-nowrap')}>
                    {r.roles.length > 0 ? r.roles.map((role) => roleLabel[role]).join('、') : '—'}
                  </td>
                  <td className={cn(DT.td, 'whitespace-nowrap')}>
                    <span className="flex items-center gap-2">
                      <Pill tone={STATUS_TONE[r.status]}>{statusLabel[r.status]}</Pill>
                      {r.status === 'pending' && r.applicationState === 'rejected' ? (
                        <span className="text-xs text-muted-foreground">已退回</span>
                      ) : null}
                      {r.orphan ? (
                        <span
                          className="text-xs text-muted-foreground"
                          title="只有登入身分：沒有角色、沒有註冊申請、沒有個人資料"
                          data-testid="orphan-badge"
                        >
                          孤兒帳號
                        </span>
                      ) : null}
                    </span>
                  </td>
                  <td className={cn(DT.td, 'tabular whitespace-nowrap text-muted-foreground')}>{r.createdAt.slice(0, 10)}</td>
                  <td className={cn(DT.td, 'whitespace-nowrap')}>
                    <span className="flex items-center gap-1">
                      {/* 票 10b：孤兒帳號先補建角色（或停用）。 */}
                      {r.orphan && r.userId !== currentUserId ? <OrphanRepairDialog account={roleTarget(r, roleLabel)} /> : null}
                      {(r.status === 'active' || r.status === 'disabled' || (r.status === 'pending' && r.orphan)) &&
                      r.userId !== currentUserId ? (
                        <StatusDialog
                          account={{
                            userId: r.userId,
                            name: r.name,
                            loginEmail: r.loginEmail,
                            studentNo: r.studentNo,
                            status: r.status,
                          }}
                        />
                      ) : null}
                      {/* 票 10b：老師或職員設為管理員、取消管理員（不能對自己；學生不能設）。 */}
                      {r.userId !== currentUserId && r.roles.includes('admin') ? (
                        <AdminRoleDialog account={roleTarget(r, roleLabel)} mode="revoke" />
                      ) : null}
                      {r.userId !== currentUserId &&
                      r.status === 'active' &&
                      !r.orphan &&
                      !r.roles.includes('admin') &&
                      !r.roles.includes('student') ? (
                        <AdminRoleDialog account={roleTarget(r, roleLabel)} mode="grant" />
                      ) : null}
                      {/* 票 8：替這一列的人發臨時密碼（待審與已核准的人才有意義；停用的人登不進來）。 */}
                      {(r.status === 'active' || r.status === 'pending') && r.userId !== currentUserId ? (
                        <TemporaryPasswordDialog
                          labels={props.verificationLabels}
                          target={{ userId: r.userId, name: r.name, email: r.loginEmail, roles: r.roles, status: r.status }}
                        />
                      ) : null}
                      {r.status === 'pending' && r.applicationState === 'pending' ? (
                        <span className="text-xs text-muted-foreground">在上方待審核清單審核</span>
                      ) : null}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </DataTableFrame>
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
  if (filter.orphan) params.orphan = '1'
  return params
}

/** 角色對話框要顯示的那一列（票 10b）。 */
function roleTarget(r: AccountRow, roleLabel: Record<Role, string>): RoleTargetView {
  return {
    userId: r.userId,
    name: r.name,
    loginEmail: r.loginEmail,
    rolesText: r.roles.length > 0 ? r.roles.map((role) => roleLabel[role]).join('、') : '沒有角色',
  }
}
