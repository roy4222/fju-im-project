'use client'
import Link from 'next/link'
import { useActionState } from 'react'
import { setStageSettingAction } from '@/app/dashboard/admin/grading/actions'
import { Feedback, INPUT, LABEL, SECONDARY } from '@/app/dashboard/admin/groups/admin-group-forms'

/**
 * 評分規則分頁每個評分項目的「對應作業、說明、評審組」（C 階段規格① §1.3、§7.4）。
 *
 * 這三樣存側表、不影響分數：改了不建新版、不受鎖定影響，老師馬上看得到。評審組選「與『X』同一組評審」時，
 * 伺服器先驗每一組兩邊的評分老師與「要幾位老師評」一致，不一致會被擋並列出組別——這時給一個連到評分老師分頁的連結去對齊。
 */

export type StageSettingActionState = { ok: boolean; message: string; panelBlocked?: boolean } | undefined

export type StageSettingFormProps = {
  cohortId: string
  stageKey: string
  stageName: string
  /** 可選的對應作業（這一屆已發布、整組繳交、不是同意書）；目前連著但已不符合的也放進來，才不會被默默清掉。 */
  items: readonly { id: string; title: string }[]
  /** 其他評分項目（評審組下拉的「與『X』同一組評審」）。 */
  others: readonly { key: string; name: string }[]
  itemId: string | null
  description: string | null
  /** 目前跟哪一個評分項目同一組評審（沒有是 null）。 */
  panelWith: string | null
  teachersHref: string
  requestId: string
  disabledReason: string | null
}

export function StageSettingsForm(p: StageSettingFormProps) {
  const [state, action, pending] = useActionState(setStageSettingAction, undefined)
  const id = (name: string) => `stage-${p.stageKey}-${name}`
  const disabled = p.disabledReason !== null
  return (
    <form action={action} className="space-y-3" aria-label={`「${p.stageName}」的對應作業與說明`}>
      <input type="hidden" name="cohortId" value={p.cohortId} />
      <input type="hidden" name="stageKey" value={p.stageKey} />
      <input type="hidden" name="stageName" value={p.stageName} />
      <input type="hidden" name="requestId" value={p.requestId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={id('item')} className={LABEL}>
            對應作業
          </label>
          <select id={id('item')} name="itemId" defaultValue={p.itemId ?? ''} className={INPUT} disabled={disabled}>
            <option value="">不對應（老師直接填分）</option>
            {p.items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.title}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={id('panel')} className={LABEL}>
            評審組
          </label>
          <select id={id('panel')} name="panelWith" defaultValue={p.panelWith ?? ''} className={INPUT} disabled={disabled || p.others.length === 0}>
            <option value="">各自指派</option>
            {p.others.map((o) => (
              <option key={o.key} value={o.key}>
                與『{o.name}』同一組評審
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label htmlFor={id('description')} className={LABEL}>
          說明（給評分老師看，選填）
        </label>
        <textarea
          id={id('description')}
          name="description"
          defaultValue={p.description ?? ''}
          maxLength={500}
          rows={2}
          className={INPUT}
          disabled={disabled}
          placeholder="例如：依發表當天表現評分"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className={SECONDARY} disabled={pending || disabled} title={p.disabledReason ?? undefined}>
          {pending ? '儲存中…' : '儲存'}
        </button>
        <span className="text-xs text-muted-foreground">不用建新版，已有老師填分也能改。</span>
      </div>
      <Feedback state={state} />
      {state && !state.ok && state.panelBlocked ? (
        <Link href={p.teachersHref} className="inline-flex text-sm font-semibold text-primary underline-offset-2 hover:underline">
          前往評分老師分頁對齊
        </Link>
      ) : null}
    </form>
  )
}
