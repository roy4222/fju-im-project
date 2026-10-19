'use client'
import { useEffect, useState, useTransition, type FormEvent } from 'react'
import type { FeFormProps } from '@/app/_ui/front-edit/forms'
import type { setHomePositionAction, showcaseFeStateAction } from '@/app/dashboard/admin/showcase/actions'

/**
 * 前台直接編輯「優秀專題」（C 階段規格① §11.3 `showcase` kind，C1-09）：只有一個「精選」勾，存的是首頁順序（`home_position`）。
 *
 * - 勾＝排進首頁輪播順序（原本沒排的接在目前最後一個後面）；不勾＝不排（輪播時排在有排的後面）。
 * - 不開完整的 `ShowcaseEditDialog`；題目、海報、獎項要到後台「公告與作業 › 成果展示」改。不能新增、不能刪。
 * - 開窗先讀這件作品目前的條目版本與順序（前台標記上沒有版本），讀到之前不能送出。
 * - 表單不刷新、不發 toast，成功只呼叫 `onDone`（框架負責）。
 *
 * Server Function 不在這裡 import：延遲 chunk 一靜態碰到 Server Function 的客戶端接線，Turbopack 就把那段接線從每頁都載的
 * 共用 chunk 拆出來、所有路由變大（同 `forms/registry.ts`、`resource-category.tsx`）。由 `forms.ts` 的登錄行在載入這個模組時
 * 用 `provideShowcaseActions` 交進來。
 */

type Actions = { load: typeof showcaseFeStateAction; setHomePosition: typeof setHomePositionAction }
let actions: Actions | null = null

/** `forms.ts` 載入這個模組時呼叫一次。 */
export function provideShowcaseActions(provided: Actions): void {
  actions = provided
}

const BTN_SUBMIT = 'btn-fju h-11 px-5 text-sm disabled:pointer-events-none disabled:opacity-60'
const HINT = '-mt-2 text-xs text-muted-foreground'

type Loaded = { revision: number; homePosition: number | null; lastPosition: number }

export default function ShowcaseFeaturedForm({ id, fields, onDone, onCancel }: FeFormProps) {
  const title = typeof fields.title === 'string' ? fields.title : ''
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [featured, setFeatured] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [requestId] = useState(() => crypto.randomUUID())
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        if (!actions) throw new Error('優秀專題的 Server Function 還沒登錄（forms.ts）。')
        const state = await actions.load(id ?? '')
        if (!alive) return
        if (!state.ok) {
          setError(state.message)
          return
        }
        setLoaded({ revision: state.revision, homePosition: state.homePosition, lastPosition: state.lastPosition })
        setFeatured(state.homePosition !== null)
      } catch {
        if (alive) setError('讀不到這件作品，請重新整理頁面。')
      }
    })()
    return () => {
      alive = false
    }
  }, [id])

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!loaded || !id) return
    if (featured === (loaded.homePosition !== null)) {
      onCancel()
      return
    }
    setError(null)
    startTransition(async () => {
      try {
        if (!actions) throw new Error('優秀專題的 Server Function 還沒登錄（forms.ts）。')
        const form = new FormData()
        form.set('entryId', id)
        form.set('revision', String(loaded.revision))
        form.set('requestId', requestId)
        form.set('homePosition', featured ? String(Math.min(loaded.lastPosition + 1, 99)) : '')
        const result = await actions.setHomePosition(undefined, form)
        if (result?.ok) onDone({ id, status: 'saved' })
        else setError(result?.message ?? '沒存到，請重新整理頁面再試。')
      } catch {
        setError('連線中斷；結果尚未確認，請重新整理頁面看看。')
      }
    })
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" aria-label={`「${title}」精選`} data-testid="fe-showcase-form">
      {error ? (
        <p role="alert" className="fe-error">
          {error}
        </p>
      ) : null}
      <label className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <input
          type="checkbox"
          checked={featured}
          onChange={(e) => setFeatured(e.target.checked)}
          disabled={!loaded || pending}
          className="size-4"
          aria-describedby="fe-hint-showcase"
        />
        精選（排進首頁輪播順序）
      </label>
      <p id="fe-hint-showcase" className={HINT}>
        {loaded
          ? loaded.homePosition !== null
            ? `目前排第 ${loaded.homePosition}。取消勾選後輪播時排在有排的作品後面。`
            : '勾選後接在目前首頁順序的最後面；要調整先後請到後台「成果展示」拖曳排序。'
          : '讀取中…'}
      </p>
      <div className="fe-actions">
        <button type="button" className="fe-btn" onClick={onCancel} disabled={pending}>
          取消
        </button>
        <button type="submit" className={BTN_SUBMIT} disabled={!loaded || pending}>
          {pending ? '儲存中…' : '儲存'}
        </button>
      </div>
    </form>
  )
}
