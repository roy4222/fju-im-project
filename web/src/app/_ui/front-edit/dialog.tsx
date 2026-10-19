'use client'
import { useEffect, useRef, type ReactNode } from 'react'

/**
 * 前台編輯的視窗外殼（C2-16；規格② 設計方案 §6.3）。
 *
 * 原生 `<dialog>`＋`showModal()`：焦點鎖、Esc、背景遮罩都是瀏覽器的，畫在 top layer，不受頁面版型影響；
 * 沒有 inline style（CSP，§6.4），樣式全在 `front-edit.css`。掛上就打開、`onClose` 由外面卸掉它。
 */
export function FeDialog({
  title,
  onClose,
  children,
  role = 'dialog',
}: {
  title: string
  onClose: () => void
  children: ReactNode
  role?: 'dialog' | 'alertdialog'
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el && !el.open) el.showModal()
    return () => {
      if (el?.open) el.close()
    }
  }, [])

  return (
    <dialog
      ref={ref}
      role={role}
      aria-labelledby="fe-dialog-title"
      className="fe-dialog"
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      <div className="fe-dialog-head">
        <h2 id="fe-dialog-title" className="fe-dialog-title">
          {title}
        </h2>
        <button type="button" className="fe-icon-btn" aria-label="關閉" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="fe-dialog-body">{children}</div>
    </dialog>
  )
}
