'use client'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { BTN_OUTLINE, BTN_PRIMARY, DIALOG } from '@/app/_ui/dashboard-kit'
import { buttonVariants } from '@/app/_ui/ui/button'
import { cn } from '@/shared/cn'
import type { ActionResult } from './gantt-model'

/**
 * 甘特的視窗與右鍵選單（規格③《設計方案》§9.3；C3-03）。只有系辦（`mode='edit'`）會載：
 * `gantt.tsx` 用 `next/dynamic` 載這支，前台唯讀版不下載。
 *
 * - `ActivityDialog`：新增／編輯活動的視窗殼；表單本體由呼叫端用 `renderForm` 注入（C3-08 放 `ActivityFormBody`）。
 * - `DeleteConfirmDialog`：「確定刪除『X』？」；失敗句原樣放 `role="alert"`。
 * - `StageConfirmDialog`：階段分界放開後的確認框；由 `gantt-mount` adapter 在 `saveSchedule` 裡用（gantt 本身不開）。
 * - `GanttContextMenu`：右鍵／長按／`Shift+F10` 的自製選單（`role="menu"`，Esc 關、焦點回橫條）。
 *
 * 全部用原生 `<dialog>`（自帶 modal、Esc 與焦點鎖，跟系辦時程頁現有的對話框一樣）。位置一律走 CSSOM，不輸出 `style=`。
 */

const DANGER = buttonVariants({ variant: 'destructive', size: 'lg', className: 'press rounded-lg px-3 font-semibold' })

/** 受控的原生 `<dialog>`：`open` 變了就 `showModal()`／`close()`；使用者按 Esc 也會回報 `onClose`。 */
function NativeDialog({
  open,
  title,
  description,
  onClose,
  wide = false,
  children,
}: {
  open: boolean
  title: string
  description?: string
  onClose: () => void
  wide?: boolean
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (open && !el.open) el.showModal()
    if (!open && el.open) el.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onClose={onClose}
      className={cn(DIALOG, wide ? 'w-[min(48rem,calc(100vw-2rem))]' : 'w-[min(36rem,calc(100vw-2rem))]')}
    >
      {open ? (
        <div className="px-6 py-5">
          <h2 className="text-lg font-extrabold">{title}</h2>
          {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
          <div className="mt-4">{children}</div>
        </div>
      ) : null}
    </dialog>
  )
}

function Alert({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <p role="alert" className="rounded-lg bg-destructive-subtle px-3 py-2 text-sm font-semibold text-destructive-on-subtle">
      {message}
    </p>
  )
}

export type ActivityFormContext = {
  mode: 'create' | 'edit'
  /** 點空白處的那天，或拖拉後的起訖（AC-C3-48）；一般「編輯」沒有。 */
  prefill?: { startDate: string; endDate: string }
  /** 表單成功後呼叫，關掉視窗。 */
  close: () => void
}

/** 新增／編輯活動的視窗殼（表單本體這票先用 `renderForm` 注入）。 */
export function ActivityDialog({
  open,
  mode,
  title,
  prefill,
  onClose,
  renderForm,
}: {
  open: boolean
  mode: 'create' | 'edit'
  /** 視窗標題，例如「新增活動」「編輯：面談」。 */
  title: string
  prefill?: { startDate: string; endDate: string }
  onClose: () => void
  renderForm: (ctx: ActivityFormContext) => ReactNode
}) {
  return (
    <NativeDialog open={open} title={title} onClose={onClose} wide>
      {renderForm({ mode, prefill, close: onClose })}
    </NativeDialog>
  )
}

/** 刪除確認（§9.1：排定中的也能直接刪，不必先取消）。 */
export function DeleteConfirmDialog({
  open,
  title,
  onConfirm,
  onClose,
  onDeleted,
}: {
  open: boolean
  /** 活動名稱。 */
  title: string
  onConfirm: () => Promise<ActionResult>
  onClose: () => void
  /** 刪除成功（視窗已關）。 */
  onDeleted: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = () => {
    setError(null)
    onClose()
  }
  const confirm = async () => {
    setBusy(true)
    setError(null)
    const result = await onConfirm()
    setBusy(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    onClose()
    onDeleted()
  }
  return (
    <NativeDialog open={open} title={`刪除「${title}」`} onClose={close}>
      <div className="space-y-4">
        <p className="text-sm">確定刪除『{title}』？學生的時程上會直接消失。</p>
        <Alert message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className={BTN_OUTLINE} onClick={close}>
            取消
          </button>
          <button type="button" className={DANGER} disabled={busy} onClick={confirm}>
            {busy ? '處理中…' : '刪除'}
          </button>
        </div>
      </div>
    </NativeDialog>
  )
}

/**
 * 階段分界／年度結束日的確認框（§9.2）。句子用 `gantt-model.ts` 的 `stageChangeMessage`。
 * 「確定」才儲存；「取消」或 Esc 由 adapter 讓 `saveSchedule` resolve `{ ok:false, cancelled:true }`（gantt 只回彈）。
 */
export function StageConfirmDialog({
  open,
  message,
  busy = false,
  error = null,
  onConfirm,
  onCancel,
}: {
  open: boolean
  message: string
  busy?: boolean
  error?: string | null
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <NativeDialog open={open} title="調整階段日期" onClose={onCancel}>
      <div className="space-y-4">
        <p className="text-sm">{message}</p>
        <Alert message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className={BTN_OUTLINE} onClick={onCancel}>
            取消
          </button>
          <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={onConfirm}>
            {busy ? '儲存中…' : '確定'}
          </button>
        </div>
      </div>
    </NativeDialog>
  )
}

/** 選單離視窗邊緣至少留這麼多。 */
const MENU_MARGIN = 8

/** 自製右鍵選單：開在游標（或橫條）旁，第一項自動聚焦；`↑↓` 換項、Esc／Tab／點外面關，關掉時焦點回橫條。 */
export function GanttContextMenu({
  x,
  y,
  label,
  returnFocus,
  onEdit,
  onDelete,
  onClose,
}: {
  /** 視窗座標（`clientX`／`clientY`）。 */
  x: number
  y: number
  /** 選單的 `aria-label`，例如「說明會 的選單」。 */
  label: string
  returnFocus: HTMLElement | null
  onEdit: () => void
  onDelete: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const left = Math.min(x, window.innerWidth - el.offsetWidth - MENU_MARGIN)
    const top = Math.min(y, window.innerHeight - el.offsetHeight - MENU_MARGIN)
    el.style.setProperty('left', `${Math.max(MENU_MARGIN, left)}px`)
    el.style.setProperty('top', `${Math.max(MENU_MARGIN, top)}px`)
    el.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [x, y])

  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [onClose])

  const closeAndReturn = () => {
    onClose()
    returnFocus?.focus()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
    const at = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault()
      closeAndReturn()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      items[(at + step + items.length) % items.length]?.focus()
    }
  }

  const item = 'block w-full rounded-md px-3 py-2 text-left text-sm font-semibold hover:bg-accent focus-visible:bg-accent focus-visible:outline-none pointer-coarse:min-h-11'
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      data-testid="gantt-menu"
      onKeyDown={onKeyDown}
      className="fixed z-50 min-w-32 rounded-lg border border-border bg-popover p-1 text-foreground shadow-lg"
    >
      <button
        type="button"
        role="menuitem"
        className={item}
        onClick={() => {
          onClose()
          onEdit()
        }}
      >
        編輯
      </button>
      <button
        type="button"
        role="menuitem"
        className={cn(item, 'text-destructive')}
        onClick={() => {
          onClose()
          onDelete()
        }}
      >
        刪除
      </button>
    </div>
  )
}
