'use client'
import { useEffect, useState } from 'react'
import type { FeFormProps } from '@/app/_ui/front-edit/forms'
import { ItemForm } from '@/app/dashboard/admin/affairs/_form/item-form'
import { deleteItemAction } from '@/app/dashboard/admin/affairs/actions'
import { frontEditContextAction, type FrontEditContext } from '@/app/dashboard/admin/affairs/front-edit-context-action'
import { formPlacementOf, toInitial, type ItemFormPlacement } from '@/app/dashboard/admin/affairs/item-form-model'

/**
 * 前台直接編輯（A8）的①表單 adapter（C 階段規格① §11.3；②§6.3.1 `FeFormProps`／`FeFormModule`）。
 * 五個 kind（`news`／`submission`／`rules`／`resource`／`honor`）共用這一份，各 kind 檔只綁 `placement`、匯出 `remove`。
 *
 * 1. 開窗就呼叫 `frontEditContextAction`：edit 依 `id` 載完整 `ItemDetail`，用 `toInitial(detail)` 當初值、revision 取自 detail；
 *    載完之前送出鈕 disabled、表單顯示載入中。`FeFields` 只拿來先顯示標題（提示），不當初值（AC-6a）。
 * 2. 固定 `layout='dialog'`；欄位錯誤與「別人剛改過」由 `ItemForm` 自己顯示。
 * 3. `onDone({itemId,status})` 轉成框架的 `onDone({id,status})`；刷新、toast、關窗都是框架的事。
 */

type Loaded = Extract<FrontEditContext, { ok: true }>

export function ItemAdapter({ placement, ...props }: FeFormProps & { placement: ItemFormPlacement }) {
  const { mode, id, cohortId, fields, onDone, onCancel } = props
  const [context, setContext] = useState<Loaded | { ok: false; message: string } | null>(null)

  useEffect(() => {
    let alive = true
    frontEditContextAction({ cohortId, itemId: mode === 'edit' ? id : null }).then(
      (result) => alive && setContext(result),
      () => alive && setContext({ ok: false, message: '表單資料載入失敗，請關掉再開一次。' }),
    )
    return () => {
      alive = false
    }
  }, [mode, id, cohortId])

  if (!context || !context.ok || (mode === 'edit' && !context.detail)) {
    const hint = typeof fields.title === 'string' ? fields.title : ''
    const failed = context && !context.ok ? context.message : null
    return (
      <div className="flex flex-col gap-4" data-testid="fe-item-loading" aria-busy={failed ? undefined : true}>
        {hint ? <p className="text-base font-bold break-words">{hint}</p> : null}
        {failed ? (
          <p role="alert" className="fe-error">
            {failed}
          </p>
        ) : (
          <p className="fe-loading">載入中…</p>
        )}
        <div className="fe-actions">
          <button type="button" className="fe-btn" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="fe-btn" disabled>
            {mode === 'edit' ? '儲存更新' : '儲存'}
          </button>
        </div>
      </div>
    )
  }

  const detail = context.detail
  const initial = detail ? toInitial(detail) : undefined
  return (
    <ItemForm
      placement={initial ? formPlacementOf(detail!.placement) : placement}
      cohortId={context.cohortId}
      itemId={detail?.id}
      initial={initial}
      options={context.options}
      layout="dialog"
      onCancel={onCancel}
      onDone={(result) => onDone({ id: result.itemId, status: result.status })}
    />
  )
}

/**
 * 前台的「刪除」：框架先確認再呼叫；不能刪時把原因（`deleteCheck`）原樣交回框架顯示在確認框。
 * 標記沒帶 revision（例如前台檔案清單）就先讀一次這一筆的目前 revision——系辦已在確認框看過名稱、按了確定。
 */
export async function removeItem(input: { id: string; revision: number | null; requestId: string }): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    let revision = input.revision
    if (revision === null) {
      const context = await frontEditContextAction({ cohortId: null, itemId: input.id })
      if (!context.ok) return { ok: false, message: context.message }
      if (!context.detail) return { ok: false, message: '這一筆已經不在了，請重新整理頁面。' }
      revision = context.detail.revision
    }
    const result = await deleteItemAction(input.id, revision, input.requestId)
    return result.ok ? { ok: true } : { ok: false, message: result.message }
  } catch {
    return { ok: false, message: '連線中斷；結果尚未確認，請重新整理頁面看狀態。' }
  }
}
