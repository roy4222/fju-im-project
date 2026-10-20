'use client'
import { useState, useTransition, type FormEvent } from 'react'
import type { FeFormProps } from '@/app/_ui/front-edit/forms'
import type { renameResourceCategoryAction } from '@/app/dashboard/admin/affairs/rename-category-action'

/**
 * 前台直接編輯「資源分類名稱」（C 階段規格① §11.3 `resource_category`，C1-07）：一欄「新名稱」。
 *
 * `id`＝舊分類名、`revision` 不用（改名不動版本）、不能新增、不取預設工作屆別；範圍是所有屆別（前台「檔案下載」依名稱合併跨屆資源）。
 * 刪除不在這裡：分類下有檔案時框架的按鈕寫「有 N 個檔案，先移走」。表單不刷新、不發 toast，成功只呼叫 `onDone`。
 * 樣式字串照 `_ui/front-edit/forms/site-text-form.tsx` 同字、不 import 共用模組（延遲 chunk，理由同那支檔）。
 *
 * Server Function 不在這裡 import：延遲 chunk 一靜態碰到 Server Function 的客戶端接線，Turbopack 就把那段接線從每頁都載的
 * 共用 chunk 拆出來、所有路由變大（同 `forms/registry.ts`、`item-form-model.ts` 的 `itemFormDeps`）。由 `forms.ts` 的登錄行在
 * 載入這個模組時用 `provideRename` 交進來。
 */

let rename: typeof renameResourceCategoryAction | null = null

/** `forms.ts` 載入這個模組時呼叫一次。 */
export function provideRename(action: typeof renameResourceCategoryAction): void {
  rename = action
}

const INPUT =
  'h-10 w-full rounded-lg border border-input bg-background px-3 text-sm font-normal text-foreground outline-none transition-[border-color,box-shadow] focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25 aria-invalid:border-destructive disabled:opacity-60'
const LABEL = 'flex flex-col gap-1.5 text-sm font-semibold text-foreground'
const BTN_SUBMIT = 'btn-fju h-11 px-5 text-sm disabled:pointer-events-none disabled:opacity-60'
const HINT = '-mt-2 text-xs text-muted-foreground'

export default function ResourceCategoryForm({ id, fields, onDone, onCancel }: FeFormProps) {
  const from = id ?? (typeof fields.name === 'string' ? fields.name : '')
  const [to, setTo] = useState(from)
  const [requestId] = useState(() => crypto.randomUUID())
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError(null)
    if (to.trim() === '') {
      setError('請填新的分類名稱。')
      return
    }
    if (to.trim() === from) {
      onCancel()
      return
    }
    startTransition(async () => {
      try {
        if (!rename) throw new Error('分類改名的 Server Function 還沒登錄（forms.ts）。')
        const result = await rename({ from, to: to.trim(), requestId })
        if (result.ok) onDone({ id: to.trim(), status: 'saved' })
        else setError(result.message)
      } catch {
        setError('連線中斷；結果尚未確認，請重新整理頁面看分類名稱。')
      }
    })
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" aria-label={`分類「${from}」改名`} data-testid="fe-resource-category-form">
      {error ? (
        <p role="alert" className="fe-error">
          {error}
        </p>
      ) : null}
      <label className={LABEL}>
        新名稱
        <input
          name="to"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          maxLength={60}
          className={INPUT}
          disabled={pending}
          aria-invalid={error !== null || undefined}
          aria-describedby="fe-hint-category"
        />
      </label>
      <p id="fe-hint-category" className={HINT}>
        各屆用這個分類的資源都會一起改名；不會通知、也不會產生新版本。
      </p>
      <div className="fe-actions">
        <button type="button" className="fe-btn" onClick={onCancel} disabled={pending}>
          取消
        </button>
        <button type="submit" className={BTN_SUBMIT} disabled={pending}>
          {pending ? '儲存中…' : '儲存'}
        </button>
      </div>
    </form>
  )
}
