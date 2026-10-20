'use client'
import './staggered-menu.css'
import { useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'

/**
 * 前台手機選單（Staggered Menu B，規格④ 設計方案 §5）：原生 `<dialog>` `showModal()`，取代原本的 `Sheet` 抽屜。
 * 開啟時三層色塊（深藍、橘、淺藍）依序從右滑入，面板再滑入、選項逐項淡入；全部是 CSS（`staggered-menu.css`）。
 * Tab 在選單裡循環；Esc、點背景、點選項都會關；關了焦點回觸發鈕（原生 dialog 的行為）。
 * `wide`：觸發鈕到 1280（`xl`）才收起，給登入後頂列放不下「我的後台」的 1024～1279（設計方案 §8 原因 C）。
 * 減少動態：不畫色塊層，面板 0.2 s 淡入。SSR 輸出關著的 dialog，client 接手。
 */
export function StaggeredMenu({ wide, children }: { wide?: boolean; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [open, setOpen] = useState(false)
  const [layers, setLayers] = useState(true)

  function show() {
    const el = dialog.current
    if (!el || el.open) return
    setLayers(!matchMedia('(prefers-reduced-motion: reduce)').matches)
    el.showModal()
    setOpen(true)
  }
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
    <>
      <button
        type="button"
        onClick={show}
        aria-expanded={open}
        aria-label={open ? '關閉選單' : '開啟選單'}
        data-open={open ? '1' : '0'}
        className={`sm-trigger inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[15px] font-semibold pointer-coarse:min-h-11 hover:bg-accent ${wide ? 'xl:hidden' : 'lg:hidden'}`}
      >
        選單
        <span aria-hidden className="sm-plus" />
      </button>
      <dialog ref={dialog} className="sm-dialog" data-open={open ? '1' : '0'} onClose={() => setOpen(false)} onClick={onClick} onKeyDown={onKeyDown}>
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
            <button type="button" aria-label="收起選單" className="sm-close inline-flex size-9 items-center justify-center rounded-lg pointer-coarse:size-11 hover:bg-accent">
              <span aria-hidden className="sm-plus" />
            </button>
          </div>
          {children}
        </div>
      </dialog>
    </>
  )
}
