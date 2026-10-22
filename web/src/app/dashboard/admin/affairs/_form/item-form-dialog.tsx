'use client'
import dynamic from 'next/dynamic'
import { useEffect, useRef } from 'react'
import { IconX } from '@tabler/icons-react'
import { SubmissionFields } from '@/app/dashboard/_submissions/submission-fields'
import type { ItemFormPage as ItemFormPageType, ItemFormProps } from '@/app/dashboard/admin/affairs/_form/item-form'
import {
  changeItemStatusAction,
  createItemAction,
  deleteItemAction,
  publishItemAction,
  reviewItemAction,
  saveDraftAction,
  startItemUploadAction,
  updatePublishedAction,
} from '@/app/dashboard/admin/affairs/actions'
import { frontEditContextAction } from '@/app/dashboard/admin/affairs/front-edit-context-action'
import { provideItemFormDeps, type ItemFormDeps } from '@/app/dashboard/admin/affairs/item-form-model'

/**
 * `ItemForm` 的按需載入外殼（C 階段規格① §2.2、§2.6）：表單本體（含 Tiptap、表單產生器、預覽）一律用 `next/dynamic`（`ssr:false`）載入。
 *
 * - `ItemFormDialog`：分頁內（與相容包裝 `QuickCreateDialog`）開的對話框版。清單頁首載只有這個外殼，打開那一刻才下載表單
 *   （`/dashboard/admin/affairs*` 的打包預算）。關掉就卸載，下次打開是乾淨的新表單。
 * - `LazyItemFormPage`：全頁 `/editor/*` 也從同一個 async chunk 載表單（`/editor/*` 預算；清單、前台、全頁三處共用同一份，
 *   不會因為各自靜態引用而讓打包器多切一次共用 chunk）。
 */

/**
 * 延遲表單要的 Server Function 與 `SubmissionFields`：由這個首載外殼在模組初始化時登錄（`item-form-model.ts` 的 `itemFormDeps`），
 * 表單本體不直接 import，免得 Turbopack 把它們從每頁都載的共用 chunk 拆出來。前台編輯沒有這個外殼，由 `_ui/front-edit/forms.ts` 登錄同一份。
 */
export const ITEM_FORM_DEPS: ItemFormDeps = {
  createItemAction,
  saveDraftAction,
  publishItemAction,
  updatePublishedAction,
  changeItemStatusAction,
  deleteItemAction,
  reviewItemAction,
  startItemUploadAction,
  frontEditContextAction,
  SubmissionFields,
}
export { provideItemFormDeps }

// 外殼也進前台編輯（`/office-edit`）的首載：不 import `dashboard-kit`（它帶 `next/link` 與 Button），樣式同 `item-form-parts.tsx` 的字面字串。
const DIALOG_CLASS =
  'm-auto w-[min(72rem,calc(100vw-2rem))] rounded-xl border border-border bg-popover p-0 text-foreground shadow-xl backdrop:bg-black/40'
const CLOSE_BUTTON =
  'inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30 [&_svg]:size-4'
provideItemFormDeps(ITEM_FORM_DEPS)

const ItemForm = dynamic(() => import('@/app/dashboard/admin/affairs/_form/item-form').then((m) => m.ItemForm), {
  ssr: false,
  loading: () => <p className="px-1 py-10 text-center text-sm text-muted-foreground">表單載入中…</p>,
})

const ItemFormPage = dynamic(() => import('@/app/dashboard/admin/affairs/_form/item-form').then((m) => m.ItemFormPage), {
  ssr: false,
  loading: () => <p className="py-16 text-center text-sm text-muted-foreground">表單載入中…</p>,
})

export function LazyItemFormPage(props: Parameters<typeof ItemFormPageType>[0]) {
  return <ItemFormPage {...props} />
}

// `admin/showcase/honor-dialogs.tsx` 的 `HonorFormDialog` 複製了這個外框（延遲 chunk 不能 import 本檔）；改一邊要一起改另一邊。
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
      className={DIALOG_CLASS}
      onCancel={(e) => {
        // Esc：交給呼叫端關（它決定要不要刷新），不讓瀏覽器自己關掉而跟 `open` 對不上。
        e.preventDefault()
        props.onCancel()
      }}
    >
      <div className="flex max-h-[90vh] flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-border px-6 py-4">
          <h2 className="text-lg font-extrabold">{title}</h2>
          <button type="button" className={CLOSE_BUTTON} onClick={props.onCancel} aria-label="關閉">
            <IconX />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 pt-5">{open ? <ItemForm {...props} layout="dialog" /> : null}</div>
      </div>
    </dialog>
  )
}
