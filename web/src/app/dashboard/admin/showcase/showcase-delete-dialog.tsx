'use client'
import { useActionState, useEffect, useRef } from 'react'
import type { deleteEntryAction } from './actions'
import type { ShowcaseEntryView } from './showcase-view'

/**
 * 按「刪除」才載入；Server Function 與共用樣式由首載外殼傳入。
 * 首次開啟後保留掛載，關窗不丟掉送出中的 action，仍會顯示完成提示；新的 requestId 代表再次開窗。
 */
export function ShowcaseDeleteDialog({
  entry,
  requestId,
  deleteEntry,
  dialogClass,
  cancelClass,
  onDeleted,
}: {
  entry: ShowcaseEntryView
  requestId: string
  deleteEntry: typeof deleteEntryAction
  dialogClass: string
  cancelClass: string
  onDeleted: (message: string) => void
}) {
  const [state, action, pending] = useActionState(deleteEntry, undefined)
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
  }, [requestId])
  useEffect(() => {
    if (!state?.ok) return
    dialog.current?.close()
    onDeleted(state.message)
  }, [state, onDeleted])

  return (
    <dialog ref={dialog} aria-label="刪除作品" className={dialogClass}>
      <form action={action} className="flex flex-col gap-4 px-6 py-5">
        <input type="hidden" name="requestId" value={requestId} />
        <input type="hidden" name="entryId" value={entry.entryId} />
        <input type="hidden" name="revision" value={entry.entryRevision} />
        <p className="text-base font-bold break-words">
          確定刪除 {entry.groupLabel}「{entry.title || '（未填題目）'}」？草稿與發布過的版本一起刪掉，前台與作品網址都不再出現，不能恢復。
        </p>
        {state && !state.ok ? (
          <p role="alert" className="rounded-lg bg-destructive-subtle px-3 py-2 text-sm font-semibold text-destructive-on-subtle">
            {state.message}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" className={cancelClass} onClick={() => dialog.current?.close()}>
            取消
          </button>
          <button
            type="submit"
            className="press inline-flex h-10 items-center rounded-lg bg-destructive px-4 text-sm font-semibold text-white disabled:opacity-60"
            disabled={pending}
          >
            {pending ? '刪除中…' : '刪除這件作品'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
