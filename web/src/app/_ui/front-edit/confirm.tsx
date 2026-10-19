'use client'
import { useRef, useState } from 'react'
import { FeDialog } from './dialog'
import { FE_FORMS, notProvided, type FeKind } from './forms'

export const FE_NOT_PROVIDED_MESSAGE = '這個區塊還不能在前台改'

/**
 * 刪除確認（C2-16；規格② 設計方案 §6.3、§6.3.1）。
 *
 * 「確定刪除『標題』？」→ 確定才載入那個 kind 的表單模組、呼叫它的 `remove`。
 * `requestId` 在打開確認框時產生一次，同一次確認重送（網路斷、按兩下）都帶同一個，冪等交給用例。
 * 回 `ok:false` 時訊息留在框裡、不關窗；成功由外面發 toast、`router.refresh()`。
 */
export function FeConfirmDelete({
  kind,
  id,
  revision,
  title,
  onCancel,
  onDeleted,
}: {
  kind: FeKind
  id: string
  revision: number | null
  title: string
  onCancel: () => void
  onDeleted: () => void
}) {
  const requestId = useRef(crypto.randomUUID())
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    const loader = FE_FORMS[kind]
    if (loader === notProvided) {
      setError(FE_NOT_PROVIDED_MESSAGE)
      return
    }
    setPending(true)
    setError(null)
    try {
      const mod = await loader()
      if (!mod.remove) {
        setError(FE_NOT_PROVIDED_MESSAGE)
        return
      }
      const result = await mod.remove({ id, revision, requestId: requestId.current })
      if (result.ok) onDeleted()
      else setError(result.message)
    } catch {
      setError('刪除失敗，請稍後再試。')
    } finally {
      setPending(false)
    }
  }

  return (
    <FeDialog title="刪除" role="alertdialog" onClose={onCancel}>
      <p className="fe-confirm-text">{title ? `確定刪除『${title}』？` : '確定刪除這一則？'}</p>
      {error ? (
        <p role="alert" className="fe-error">
          {error}
        </p>
      ) : null}
      <div className="fe-actions">
        <button type="button" className="fe-btn" onClick={onCancel} disabled={pending}>
          取消
        </button>
        <button type="button" className="fe-btn fe-btn-danger" onClick={confirm} disabled={pending}>
          {pending ? '刪除中…' : '確定刪除'}
        </button>
      </div>
    </FeDialog>
  )
}
