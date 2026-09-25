'use client'
import { useRef, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { IconPlus } from '@tabler/icons-react'
import { BTN_OUTLINE_TALL, BTN_PAGE, DIALOG, DIALOG_DESC, DIALOG_TITLE } from '@/app/_ui/dashboard/look'

/**
 * 原型簽核頁右上的「新增簽核」：一顆橘色按鈕打開對話框（原型 `new-signoff-dialog.tsx`）。
 *
 * 對話框裡就是原本的「建立簽核版本」表單（票 25），行為不變；關掉對話框時刷新頁面，
 * 讓下面「各組進度」看到剛建立的版本。
 */
export function NewVersionDialog({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  const router = useRouter()
  return (
    <>
      <button type="button" className={BTN_PAGE} onClick={() => ref.current?.showModal()}>
        <IconPlus className="size-4" aria-hidden />
        新增簽核
      </button>
      <dialog ref={ref} aria-label="新增簽核" className={DIALOG.xl} onClose={() => router.refresh()}>
        <div className="flex flex-col gap-4 p-5">
          <div>
            <h2 className={DIALOG_TITLE}>新增簽核</h2>
            <p className={DIALOG_DESC}>
              建立一份要全組逐人同意的版本。系辦只能發布、重開、重置，不能代替學生或老師同意。同一組同一用途再建一版，舊版就失效、所有人重新同意。
            </p>
          </div>
          {children}
          <div className="flex justify-end border-t border-border pt-4">
            <button type="button" className={BTN_OUTLINE_TALL} onClick={() => ref.current?.close()}>
              關閉
            </button>
          </div>
        </div>
      </dialog>
    </>
  )
}
