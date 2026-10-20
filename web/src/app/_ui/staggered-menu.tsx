'use client'
import './staggered-menu.css'
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'

/**
 * 前台手機選單的面板（Staggered Menu B，規格④ 設計方案 §5）：原生 `<dialog>` `showModal()`，取代原本的 `Sheet` 抽屜。
 * 觸發鈕在 `site-header.tsx`；這支連同 CSS 是**點開才下載**（載入樁 `loadStaggeredMenu` 在 `dash-theme.tsx`，主腦裁定 C4-09 ESCALATE 1），
 * 所以只 import react 與自己的 CSS，不碰 `cn`、`ui/button` 這類共用模組（否則 Turbopack 會重切共用 chunk）；選項由頁首當 children 傳進來。
 * 開啟時三層色塊（深藍、橘、淺藍）依序從右滑入，面板再滑入、選項逐項淡入；全部是 CSS（`staggered-menu.css`）。
 * Tab 在選單裡循環；Esc、點背景、點選項都會關；關了焦點回觸發鈕（原生 dialog 的行為）。
 * 減少動態：不畫色塊層，面板 0.2 s 淡入。
 */
export function StaggeredMenu({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [layers] = useState(() => !matchMedia('(prefers-reduced-motion: reduce)').matches)

  useEffect(() => {
    const el = dialog.current
    if (open && el && !el.open) el.showModal()
  }, [open])

  const close = () => dialog.current?.close()

  function onClick(event: MouseEvent<HTMLDialogElement>) {
    // 點到 dialog 本身＝點到面板外的背景；點到選項（連結或登出鈕）也關。
    if (event.target === event.currentTarget || (event.target as Element).closest('a, button')) close()
  }

  function onKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== 'Tab') return
    const items = event.currentTarget.querySelectorAll<HTMLElement>('a[href], button')
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) return
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    }
  }

  return (
    <dialog ref={dialog} className="sm-dialog" data-open={open ? '1' : '0'} onClose={onClose} onClick={onClick} onKeyDown={onKeyDown}>
      {open && layers ? (
        <>
          <span aria-hidden className="sm-layer" />
          <span aria-hidden className="sm-layer" />
          <span aria-hidden className="sm-layer" />
        </>
      ) : null}
      <div className={layers ? 'sm-panel' : 'sm-panel sm-panel-plain'}>
        <div className="flex items-center justify-between px-4 pt-4">
          <span className="text-base font-semibold">選單</span>
          <button type="button" aria-label="收起選單" className="inline-flex size-9 items-center justify-center rounded-lg text-xl pointer-coarse:size-11 hover:bg-accent">
            <span aria-hidden>×</span>
          </button>
        </div>
        {children}
      </div>
    </dialog>
  )
}
