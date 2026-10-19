'use client'
import dynamic from 'next/dynamic'
import { useEffect, useRef } from 'react'
import { IconX } from '@tabler/icons-react'
import { BTN_ICON, DIALOG } from '@/app/_ui/dashboard-kit'
import type { ItemFormProps } from '@/app/dashboard/admin/affairs/_form/item-form'
import { cn } from '@/shared/cn'

/**
 * 分頁內（與相容包裝 `QuickCreateDialog`）開的對話框版 `ItemForm`（C 階段規格① §2.2、§2.6）。
 *
 * 表單本體（含 Tiptap、表單產生器、預覽）用 `next/dynamic`（`ssr:false`）**按需載入**：清單頁首載只有這個外殼，
 * 打開對話框那一刻才下載表單（`/dashboard/admin/affairs*` 的打包預算）。關掉就卸載，下次打開是乾淨的新表單。
 */

const ItemForm = dynamic(() => import('@/app/dashboard/admin/affairs/_form/item-form').then((m) => m.ItemForm), {
  ssr: false,
  loading: () => <p className="px-1 py-10 text-center text-sm text-muted-foreground">表單載入中…</p>,
})

export function ItemFormDialog({ open, title, ...props }: Omit<ItemFormProps, 'layout'> & { open: boolean; title: string }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const el = dialog.current
    if (!el) return
    if (open && !el.open) el.showModal()
    if (!open && el.open) el.close()
  }, [open])

  return (
    <dialog
      ref={dialog}
      aria-label={title}
      className={cn(DIALOG, 'w-[min(72rem,calc(100vw-2rem))]')}
      onCancel={(e) => {
        // Esc：交給呼叫端關（它決定要不要刷新），不讓瀏覽器自己關掉而跟 `open` 對不上。
        e.preventDefault()
        props.onCancel()
      }}
    >
      <div className="flex max-h-[90vh] flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-border px-6 py-4">
          <h2 className="text-lg font-extrabold">{title}</h2>
          <button type="button" className={BTN_ICON} onClick={props.onCancel} aria-label="關閉">
            <IconX />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 pt-5">{open ? <ItemForm {...props} layout="dialog" /> : null}</div>
      </div>
    </dialog>
  )
}
