'use client'
import { useRef, useState, type ReactNode, type RefObject } from 'react'
import Link from 'next/link'
import { IconDots, IconDownload } from '@tabler/icons-react'
import { BulkBar, DataTableFrame, DataTableToolbar, DT, EmptyRow, SortLink } from '@/app/_ui/data-table'
import { Pill } from '@/app/_ui/dashboard/primitives'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/app/_ui/ui/dropdown-menu'
import type { AccountRow, AccountStatus, DirectoryFilter, DirectorySort, Role } from '@/application/accounts'
import { cn } from '@/shared/cn'
import { taipeiDateOf } from '@/shared/time'
import { AvatarResetDialog } from './avatar-reset-dialog'
import { DeidentifyDialog } from './deidentify-dialog'
import { EditAccountDialog } from './edit-account-dialog'
import { AdminRoleDialog, OrphanRepairDialog, type DialogOpener, type RoleTargetView } from './role-dialogs'
import { StatusDialog } from './status-dialog'
import { TemporaryPasswordDialog, type VerificationLabels } from './temporary-password-dialog'

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
// 列上的停用是紅字細框（C 階段規格② §3.2：A23 拿掉危險操作群組，停用直接放列上）。
const ROW_DANGER = 'h-7 border border-destructive/40 bg-background px-2.5 text-[0.8rem] font-medium text-destructive hover:bg-destructive/10'

// 網站問題 #7（AD-11）：拿掉表格最小寬度，次要欄（系級、建立）窄螢幕先藏，操作欄貼右邊；1280 寬整張放得下、不用橫捲。
const WIDE_ONLY = 'hidden min-[1800px]:table-cell'
const STICKY_CELL = 'sticky right-0 bg-card shadow-[-1px_0_0_var(--color-border)]'

export type SortHeader = { readonly href: string; readonly active: 'asc' | 'desc' | null }

export type AccountsTableProps = {
  readonly rows: readonly AccountRow[]
  readonly total: number
  readonly filter: DirectoryFilter
  readonly currentUserId: string
  readonly statusLabel: Record<AccountStatus, string>
  readonly roleLabel: Record<Role, string>
  readonly sortHeaders: Record<DirectorySort, SortHeader>
  /** 票 8 的「發臨時密碼」對話框要用的核實方式標籤（app 對 application 只能帶型別，值由頁面傳進來）。 */
  readonly verificationLabels: VerificationLabels
  /** 每列目前的頭像（伺服器畫好；重設頭像對話框用，只有已核准、已停用的人有）。 */
  readonly avatars: Readonly<Record<string, ReactNode>>
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
  // 篩選、排序、換頁之後，不在畫面上的帳號不算勾選（比照分組表；避免匯出看不到的人）。
  const visibleSelected = pageIds.filter((id) => selected.has(id))
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
      {/* 原型 Data Table 的工具列：搜尋、篩選鈕（頁面給），右邊是整份匯出（批次停用在「已停用」分頁的標題列）。 */}
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
        </span>
      </DataTableToolbar>

      {/* 批次動作列：只在有勾選時出現（原型：橘色細框、淡橘底）。 */}
      {visibleSelected.length > 0 ? (
        <BulkBar role="toolbar" aria-label="批次動作">
          <span className="tabular text-sm font-medium" data-testid="selected-count">
            已勾選 {visibleSelected.length} 筆
          </span>
          <span className="text-xs text-muted-foreground">（目前篩選結果共 {total} 筆）</span>
          <div className="ml-auto flex flex-wrap gap-2">
            <button
              type="button"
              className={cn(BUTTON, SECONDARY, small)}
              disabled={busy}
              onClick={() => exportCsv({ kind: 'ids', userIds: visibleSelected })}
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
        <table className={DT.table} aria-label="帳號列表">
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
              <th scope="col" className={cn(DT.th, WIDE_ONLY)}>{header('系級')}</th>
              <th scope="col" className={DT.th}>{header('屆別', 'cohort')}</th>
              <th scope="col" className={DT.th}>{header('Email')}</th>
              <th scope="col" className={DT.th}>{header('角色')}</th>
              <th scope="col" className={DT.th}>{header('狀態', 'status')}</th>
              <th scope="col" className={cn(DT.th, WIDE_ONLY)}>{header('建立', 'createdAt')}</th>
              <th scope="col" className={cn(DT.th, STICKY_CELL, 'bg-muted')}>操作</th>
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
                    {/* 長名字截斷、滑過看全名，不把整張表撐寬（#7）。 */}
                    <span className="inline-block max-w-[6rem] truncate align-middle 2xl:max-w-[10rem]" title={r.name}>
                      {r.name}
                    </span>
                  </td>
                  <td className={cn(DT.td, 'tabular whitespace-nowrap')}>{r.studentNo ?? '—'}</td>
                  <td className={cn(DT.td, WIDE_ONLY, 'whitespace-nowrap')}>{r.departmentClass || '—'}</td>
                  <td className={cn(DT.td, 'tabular whitespace-nowrap')}>
                    {/* A16 互連（C 階段規格② §3.1）：屆別連到那一屆的分組總覽，有組的人多一行連到那一組（③的路由）。 */}
                    {r.cohortId ? (
                      <Link
                        href={`/dashboard/admin/groups?cohort=${r.cohortId}`}
                        className="block max-w-[7rem] truncate underline-offset-4 hover:text-primary hover:underline"
                        title={cohortText(r)}
                      >
                        {cohortText(r)}
                      </Link>
                    ) : (
                      <span className="block max-w-[7rem] truncate" title={cohortText(r)}>
                        {cohortText(r)}
                      </span>
                    )}
                    {r.groupId && r.groupCode ? (
                      <Link
                        href={`/dashboard/admin/groups/${r.groupId}`}
                        className="block text-xs text-muted-foreground underline-offset-4 hover:text-primary hover:underline"
                      >
                        {r.groupCode}
                      </Link>
                    ) : null}
                  </td>
                  <td className={cn(DT.td, 'text-muted-foreground')}>
                    <span className="block max-w-[9rem] truncate 2xl:max-w-[14rem]" title={r.loginEmail}>
                      {r.loginEmail}
                    </span>
                  </td>
                  <td className={cn(DT.td, 'whitespace-nowrap')}>
                    {r.roles.length > 0 ? r.roles.map((role) => roleLabel[role]).join('、') : '—'}
                  </td>
                  <td className={cn(DT.td, 'whitespace-nowrap')}>
                    {/* 狀態與附註上下排，窄螢幕不把欄撐寬（#7）。 */}
                    <span className="flex flex-col items-start gap-0.5 2xl:flex-row 2xl:items-center 2xl:gap-2">
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
                          未設定身分
                        </span>
                      ) : null}
                    </span>
                  </td>
                  <td className={cn(DT.td, WIDE_ONLY, 'tabular whitespace-nowrap text-muted-foreground')}>{taipeiDateOf(new Date(r.createdAt))}</td>
                  <td className={cn(DT.td, STICKY_CELL, 'whitespace-nowrap')}>
                    <span className="flex items-center gap-1">
                      {/* C 階段規格② §3.2：列上順序固定「編輯、發臨時密碼、停用／恢復、更多」。自己那一列都不顯示。 */}
                      {r.userId !== currentUserId && r.status !== 'deidentified' ? (
                        // C2-08：姓名、學號、調屆、學生↔老師互轉；停用、待審、未設定身分的人視窗裡直接寫原因。
                        <EditAccountDialog account={{ userId: r.userId, name: r.name }} />
                      ) : null}
                      {/* 票 8：替這一列的人發臨時密碼（待審與已核准的人才有意義；停用的人登不進來）。 */}
                      {(r.status === 'active' || r.status === 'pending') && r.userId !== currentUserId ? (
                        <TemporaryPasswordDialog
                          labels={props.verificationLabels}
                          target={{ userId: r.userId, name: r.name, email: r.loginEmail, roles: r.roles, status: r.status }}
                        />
                      ) : null}
                      {r.userId !== currentUserId ? <RowStatusButton row={r} /> : null}
                      {r.userId !== currentUserId ? <RowMoreMenu row={r} roleLabel={roleLabel} avatar={props.avatars[r.userId]} /> : null}
                      {r.status === 'pending' && r.applicationState === 'pending' ? (
                        <Link
                          href="/dashboard/admin/accounts/pending"
                          className="sr-only text-xs text-muted-foreground underline-offset-4 hover:underline 2xl:not-sr-only"
                        >
                          到待審核分頁審核
                        </Link>
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

/** 屆別欄：「第 43 屆（115）」；沒有名稱時只顯示代碼。 */
function cohortText(r: AccountRow): string {
  if (!r.cohortCode) return '—'
  return r.cohortName ? `${r.cohortName}（${r.cohortCode}）` : r.cohortCode
}

/**
 * 列上的「停用／恢復」（C 階段規格② §3.2、A20／A23）：已核准的人與孤兒帳號是紅字細框的「停用」，停用的人是「恢復」。
 * 停用自己畫按鈕、用 `opener` 打開既有的停用對話框（對話框內部不動：理由選填、組長先指定接任）。
 */
function RowStatusButton({ row: r }: { row: AccountRow }) {
  const disableRef = useRef<DialogOpener>(null)
  const account = { userId: r.userId, name: r.name, loginEmail: r.loginEmail, studentNo: r.studentNo }
  if (r.status === 'disabled') return <StatusDialog account={{ ...account, status: 'disabled' }} />
  // 票 9／10b：已核准的人與孤兒帳號可以停用（有註冊申請的待審帳號請退回）。
  if (!(r.status === 'active' || (r.status === 'pending' && r.orphan))) return null
  return (
    <>
      <button type="button" className={cn(BUTTON, ROW_DANGER)} aria-label={`停用 ${r.name}`} onClick={() => disableRef.current?.open()}>
        停用
      </button>
      <StatusDialog account={{ ...account, status: r.status === 'active' ? 'active' : 'pending' }} opener={disableRef} />
    </>
  )
}

/**
 * 列上的「更多」選單（T6 系6）：補建角色、設為／取消管理員、重設頭像；最後一項是紅字的「刪除個人資料」（原「去識別化」）。
 * C 階段規格② A23：拿掉「危險操作」群組標籤，停用移到列上。
 * 對話框留在列上（選單關掉就消失，放不進去），選單項只負責打開；一個項目都沒有就不顯示「更多」。
 * 自己那一列由呼叫端擋掉；已去識別化的列一律沒有「更多」。
 */
function RowMoreMenu({ row: r, roleLabel, avatar }: { row: AccountRow; roleLabel: Record<Role, string>; avatar: ReactNode }) {
  const orphanRef = useRef<DialogOpener>(null)
  const grantRef = useRef<DialogOpener>(null)
  const revokeRef = useRef<DialogOpener>(null)
  const deidentifyRef = useRef<DialogOpener>(null)
  const avatarResetRef = useRef<DialogOpener>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // 票 10b：孤兒帳號先補建角色（或停用）。
  const canRepair = r.orphan
  // 票 10b：老師或職員設為管理員、取消管理員（學生不能設）。
  const canRevoke = r.roles.includes('admin')
  const canGrant = r.status === 'active' && !r.orphan && !r.roles.includes('admin') && !r.roles.includes('student')
  // 票 40：去識別化（已核准或已停用；前置條件與二次確認在對話框與伺服器）。
  const canDeidentify = r.status === 'active' || r.status === 'disabled'
  // AD-B2：重設頭像（有個人資料的人：已核准或已停用；已去識別化的列沒有「更多」）。
  const canAvatarReset = r.status === 'active' || r.status === 'disabled'
  if (r.status === 'deidentified' || (!canAvatarReset && !canRepair && !canRevoke && !canGrant && !canDeidentify)) return null

  const target = roleTarget(r, roleLabel)
  // 等選單關完再開對話框，焦點才會留在對話框裡。開之前先把焦點放回「更多」：
  // 原生 <dialog> 關閉時把焦點還給打開前的元素，按 Escape 或取消才會回到這一列，不會掉到 body。
  const later = (ref: RefObject<DialogOpener | null>) => () =>
    setTimeout(() => {
      triggerRef.current?.focus()
      ref.current?.open()
    }, 0)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              ref={triggerRef}
              type="button"
              aria-label={`更多 ${r.name}`}
              className={cn(BUTTON, 'h-7 border-transparent bg-transparent px-2 text-muted-foreground hover:bg-muted hover:text-foreground')}
            >
              <IconDots aria-hidden />
            </button>
          }
        />
        <DropdownMenuContent align="end" className="w-40">
          {canRepair ? (
            <DropdownMenuItem aria-label={`補上身分 ${r.name}`} onClick={later(orphanRef)}>
              補上身分
            </DropdownMenuItem>
          ) : null}
          {canGrant ? (
            <DropdownMenuItem aria-label={`設為管理員 ${r.name}`} onClick={later(grantRef)}>
              設為管理員
            </DropdownMenuItem>
          ) : null}
          {canRevoke ? (
            <DropdownMenuItem aria-label={`取消管理員 ${r.name}`} onClick={later(revokeRef)}>
              取消管理員
            </DropdownMenuItem>
          ) : null}
          {canAvatarReset ? (
            <DropdownMenuItem aria-label={`重設頭像 ${r.name}`} onClick={later(avatarResetRef)}>
              重設頭像
            </DropdownMenuItem>
          ) : null}
          {canDeidentify ? (
            <>
              {canRepair || canGrant || canRevoke || canAvatarReset ? <DropdownMenuSeparator /> : null}
              {/* 對象、後果、能不能恢復寫在對話框；這裡只是最後一項紅字。 */}
              <DropdownMenuItem variant="destructive" aria-label={`刪除 ${r.name} 的個人資料`} onClick={later(deidentifyRef)}>
                刪除個人資料
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {canRepair ? <OrphanRepairDialog account={target} opener={orphanRef} /> : null}
      {canGrant ? <AdminRoleDialog account={target} mode="grant" opener={grantRef} /> : null}
      {canRevoke ? <AdminRoleDialog account={target} mode="revoke" opener={revokeRef} /> : null}
      {canDeidentify ? <DeidentifyDialog account={{ userId: r.userId, name: r.name }} opener={deidentifyRef} /> : null}
      {canAvatarReset ? (
        <AvatarResetDialog
          account={{ userId: r.userId, name: r.name }}
          avatar={avatar}
          opener={avatarResetRef}
        />
      ) : null}
    </>
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
