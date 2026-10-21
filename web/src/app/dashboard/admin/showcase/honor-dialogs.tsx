'use client'
import dynamic from 'next/dynamic'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ItemFormProps } from '@/app/dashboard/admin/affairs/_form/item-form'
import type { FrontEditContext } from '@/app/dashboard/admin/affairs/front-edit-context-action'
import { formPlacementOf, provideItemFormDeps, toInitial, type EditorVocabulary, type ItemFormDeps } from '@/app/dashboard/admin/affairs/item-form-model'

/**
 * 成果展示榮譽榜區的「新增／編輯榮譽」表單視窗與「刪除」確認框（CL-4：按下才下載，不進 `/dashboard/admin/showcase` 首載）。
 *
 * 照 `_ui/front-edit/forms.ts` 的 FE_FORMS 寫法：這個延遲 chunk 不靜態 import Server Function、`cn`、Button、圖示（關閉鈕的圖示由外殼傳入）；
 * 首載外殼（`showcase-forms.tsx`）載入本模組時呼叫 `provideHonorDeps` 把 Server Function 與 `SubmissionFields` 交進來，
 * 這裡再登錄給共用表單（`item-form-model.ts` 的 `itemFormDeps`）。表單本體跟公告分頁同一個 async chunk（`_form/item-form`）。
 */

let deps: ItemFormDeps | null = null

export function provideHonorDeps(value: ItemFormDeps): void {
  deps = value
  provideItemFormDeps(value)
}

function honorDeps(): ItemFormDeps {
  if (!deps) throw new Error('榮譽視窗的 Server Function 還沒登錄（要經 showcase-forms.tsx 載入）。')
  return deps
}

const ItemForm = dynamic(() => import('@/app/dashboard/admin/affairs/_form/item-form').then((m) => m.ItemForm), {
  ssr: false,
  loading: () => <p className="px-1 py-10 text-center text-sm text-muted-foreground">表單載入中…</p>,
})

// 跟 `affairs/_form/item-form-dialog.tsx` 的 `ItemFormDialog` 外框同一份（樣式字串、Esc 交給呼叫端、關閉鈕）；改一邊要一起改另一邊。
// 不直接用它：那個檔靜態 import Server Function 與 `SubmissionFields`，放進延遲 chunk 會重切共用 chunk。
const DIALOG_CLASS =
  'm-auto w-[min(72rem,calc(100vw-2rem))] rounded-xl border border-border bg-popover p-0 text-foreground shadow-xl backdrop:bg-black/40'
const CLOSE_BUTTON =
  'inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30 [&_svg]:size-4'

type FormDone = Parameters<ItemFormProps['onDone']>[0]

/** 新增（沒有 `context.detail`）或編輯（有）一則榮譽。 */
export function HonorFormDialog({
  title,
  closeIcon,
  cohortId,
  options,
  context,
  onCancel,
  onDone,
}: {
  title: string
  /** 關閉鈕的圖示（外殼傳入：延遲 chunk 一 import 圖示套件，Turbopack 就把它的共用部分從後台各頁的 chunk 拆出來）。 */
  closeIcon: ReactNode
  cohortId: string
  options: EditorVocabulary
  /** 編輯：`frontEditContextAction({ itemId })` 讀到的那一筆。 */
  context?: Extract<FrontEditContext, { ok: true }>
  onCancel: () => void
  onDone: (result: FormDone) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const detail = context?.detail ?? null
  const [initial] = useState(() => (detail ? toInitial(detail, null, context?.avatarUrls ?? []) : undefined))

  useEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
  }, [])

  return (
    <dialog
      ref={dialog}
      aria-label={title}
      className={DIALOG_CLASS}
      onCancel={(e) => {
        e.preventDefault()
        onCancel()
      }}
    >
      <div className="flex max-h-[90vh] flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-border px-6 py-4">
          <h2 className="text-lg font-extrabold">{title}</h2>
          <button type="button" className={CLOSE_BUTTON} onClick={onCancel} aria-label="關閉">
            {closeIcon}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 pt-5">
          <ItemForm
            layout="dialog"
            placement={detail ? formPlacementOf(detail.placement) : 'honor'}
            cohortId={cohortId}
            itemId={detail?.id}
            initial={initial}
            options={options}
            onCancel={onCancel}
            onDone={onDone}
          />
        </div>
      </div>
    </dialog>
  )
}

/**
 * 「刪除」一句話確認。送出中按 Esc／取消可以先關窗，請求照跑；結果（成功或失敗）都交給外殼在右下角提示，
 * 不會因為這一列被刪掉而看不到（CL-4）。
 */
export function HonorDeleteDialog({
  row,
  dialogClass,
  cancelClass,
  onCancel,
  onDone,
  onPending,
}: {
  row: { id: string; title: string }
  dialogClass: string
  cancelClass: string
  onCancel: () => void
  /** 結束：關窗並在外殼提示這句。 */
  onDone: (message: string, deleted: boolean) => void
  onPending: (pending: boolean) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [requestId] = useState(() => crypto.randomUUID())
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busy = useRef(false)
  const closed = useRef(false)
  const finished = useRef(false)

  useEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
  }, [])

  // 沒在送出：關窗＝取消。送出中：只把視窗收起來，結果回來再由外殼提示。
  const onClose = () => {
    if (finished.current) return
    if (busy.current) closed.current = true
    else onCancel()
  }

  async function confirm() {
    const { frontEditContextAction, deleteItemAction } = honorDeps()
    busy.current = true
    setPending(true)
    setError(null)
    onPending(true)
    let failure: string | null = null
    try {
      // 清單列沒有 revision：先讀一次這一筆目前的版本（同公告分頁的「刪除」）。
      const context = await frontEditContextAction({ cohortId: null, itemId: row.id })
      if (!context.ok || !context.detail) {
        failure = context.ok ? '這一筆已經不在了，請重新整理頁面。' : context.message
      } else {
        const result = await deleteItemAction(row.id, context.detail.revision, requestId)
        if (result.ok) {
          finished.current = true
          busy.current = false
          onPending(false)
          dialog.current?.close()
          onDone(result.message ?? '已刪除。', true)
          return
        }
        failure = result.message
      }
    } catch {
      failure = '連線中斷；結果尚未確認，請重新整理頁面看狀態。'
    }
    busy.current = false
    setPending(false)
    onPending(false)
    if (closed.current) onDone(failure, false)
    else setError(failure)
  }

  return (
    <dialog
      ref={dialog}
      aria-label={`刪除「${row.title}」`}
      className={`${dialogClass} w-[min(28rem,calc(100vw-2rem))]`}
      onCancel={(e) => {
        e.preventDefault()
        dialog.current?.close()
      }}
      onClose={onClose}
    >
      <div className="flex flex-col gap-4 px-6 py-5">
        <p className="text-base font-bold break-words">確定刪除「{row.title}」？刪了就不能恢復。</p>
        {error ? (
          <p role="alert" className="rounded-lg bg-destructive-subtle px-3 py-2 text-sm font-semibold text-destructive-on-subtle">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" className={cancelClass} onClick={() => dialog.current?.close()}>
            取消
          </button>
          <button
            type="button"
            className="press inline-flex h-9 items-center rounded-lg bg-destructive px-4 text-sm font-semibold text-white disabled:opacity-60"
            disabled={pending}
            onClick={confirm}
          >
            {pending ? '刪除中…' : '刪除'}
          </button>
        </div>
      </div>
    </dialog>
  )
}
