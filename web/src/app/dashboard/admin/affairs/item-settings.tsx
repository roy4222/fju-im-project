'use client'
import { useState } from 'react'
import { INPUT, LABEL, newField, SECONDARY, type EditorState, type EditorVocabulary, type FieldDraft } from './item-form-parts'
import { cn } from '@/shared/cn'

/**
 * 發布設定（位置、收件單位、對象、階段、開放與截止）與收件欄位編輯（票 15）。
 * 快速建立第 1 步與完整編輯器第 3 段用同一個元件，規則在伺服器判，這裡只收斂畫面上的選項。
 */

export function SettingsFields({
  state,
  onChange,
  vocabulary,
  published,
  unitLocked,
  idPrefix,
}: {
  state: EditorState
  onChange: (patch: Partial<EditorState>) => void
  vocabulary: EditorVocabulary
  /** 已發布：不能換位置、不能改開放時間。 */
  published: boolean
  /** 有人作答：收件單位與對象鎖定。 */
  unitLocked: boolean
  idPrefix: string
}) {
  const collects = state.placement === 'submission'
  const audiences = collects
    ? vocabulary.audiences.filter((a) => vocabulary.collectionAudiences.includes(a.value))
    : vocabulary.audiences
  const id = (name: string) => `${idPrefix}-${name}`

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <fieldset className="sm:col-span-2">
        <legend className={LABEL}>發布位置（單選）</legend>
        <div className="mt-1 grid gap-2 sm:grid-cols-3">
          {vocabulary.placements.map((p) => (
            <label
              key={p.value}
              className={cn(
                'flex cursor-pointer flex-col rounded-md border px-3 py-2 text-sm',
                state.placement === p.value ? 'border-primary bg-primary-subtle' : 'border-border hover:bg-muted',
                published && state.placement !== p.value && 'cursor-not-allowed opacity-50',
              )}
            >
              <span className="flex items-center gap-2 font-medium text-ink">
                <input
                  type="radio"
                  name={id('placement')}
                  value={p.value}
                  checked={state.placement === p.value}
                  disabled={published}
                  onChange={() => {
                    const toCollect = p.value === 'submission'
                    onChange({
                      placement: p.value,
                      // 收件只能發給本屆學生或指定組別；換成收件時把不合的對象改回本屆學生。
                      ...(toCollect && !vocabulary.collectionAudiences.includes(state.audienceKind)
                        ? { audienceKind: 'cohort_students' }
                        : {}),
                      receiverUnit: toCollect ? (state.receiverUnit === 'none' ? 'group' : state.receiverUnit) : 'none',
                    })
                  }}
                />
                {p.label}
              </span>
              {p.hint ? <span className="mt-0.5 text-xs text-muted-foreground">{p.hint}</span> : null}
            </label>
          ))}
        </div>
      </fieldset>

      {collects ? (
        <fieldset className="sm:col-span-2">
          <legend className={LABEL}>收件單位</legend>
          <div className="mt-1 flex flex-wrap gap-2">
            {vocabulary.units
              .filter((u) => u.value !== 'none')
              .map((u) => (
                <label
                  key={u.value}
                  className={cn(
                    'inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm',
                    state.receiverUnit === u.value ? 'border-primary bg-primary-subtle' : 'border-border',
                    unitLocked && 'cursor-not-allowed opacity-60',
                  )}
                >
                  <input
                    type="radio"
                    name={id('unit')}
                    value={u.value}
                    checked={state.receiverUnit === u.value}
                    disabled={unitLocked}
                    onChange={() => onChange({ receiverUnit: u.value })}
                  />
                  {u.label}
                </label>
              ))}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {unitLocked
              ? '已經有人作答，收件單位鎖定、不能再切換。'
              : '個人一份：每位學生各交一份。整組一份：組員共用一份，任一人送出代表整組。有人作答後就不能切換。'}
          </p>
        </fieldset>
      ) : null}

      <div>
        <label htmlFor={id('audience')} className={LABEL}>
          發布對象
        </label>
        <select
          id={id('audience')}
          className={INPUT}
          value={state.audienceKind}
          disabled={unitLocked}
          onChange={(e) => onChange({ audienceKind: e.target.value })}
        >
          {audiences.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
        {collects ? <p className="mt-1 text-xs text-muted-foreground">收件只能發給本屆學生或指定組別。</p> : null}
      </div>

      {collects ? (
        <div>
          <label htmlFor={id('stage')} className={LABEL}>
            所屬階段
          </label>
          <select id={id('stage')} className={INPUT} value={state.stageId} onChange={(e) => onChange({ stageId: e.target.value })}>
            <option value="">請選擇</option>
            {vocabulary.stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          {vocabulary.stages.length === 0 ? (
            <p className="mt-1 text-xs text-danger-on-subtle">這一屆還沒設定階段，請先到時間軸設定。</p>
          ) : null}
        </div>
      ) : null}

      {state.audienceKind === 'groups' ? (
        <fieldset className="sm:col-span-2">
          <legend className={LABEL}>指定組別（已選 {state.groupIds.length} 組）</legend>
          {vocabulary.groups.length === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">這一屆還沒有成立的組別。</p>
          ) : (
            <div className="mt-1 flex flex-wrap gap-2">
              {vocabulary.groups.map((g) => {
                const on = state.groupIds.includes(g.id)
                return (
                  <label
                    key={g.id}
                    className={cn(
                      'inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm tabular-nums',
                      on ? 'border-primary bg-primary-subtle' : 'border-border',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={unitLocked}
                      onChange={() =>
                        onChange({ groupIds: on ? state.groupIds.filter((x) => x !== g.id) : [...state.groupIds, g.id] })
                      }
                    />
                    {g.code}（{g.memberCount} 人）
                  </label>
                )
              })}
            </div>
          )}
        </fieldset>
      ) : null}

      {collects ? (
        <>
          <div>
            <label htmlFor={id('opens')} className={LABEL}>
              開放時間（選填）
            </label>
            <input
              id={id('opens')}
              type="datetime-local"
              className={INPUT}
              value={state.opensAt}
              disabled={published}
              onChange={(e) => onChange({ opensAt: e.target.value })}
            />
            <p className="mt-1 text-xs text-muted-foreground">留空＝發布即開放；發布時會記下實際開放時間，之後不會重設。</p>
          </div>
          <div>
            <label htmlFor={id('due')} className={LABEL}>
              截止時間（臺灣時間，含這一分鐘）
            </label>
            <input
              id={id('due')}
              type="datetime-local"
              className={INPUT}
              value={state.dueAt}
              onChange={(e) => onChange({ dueAt: e.target.value })}
            />
            <p className="mt-1 text-xs text-muted-foreground">例如 23:59：23:59:59 前送出都算準時，00:00 起就算遲交。</p>
          </div>
        </>
      ) : null}
    </div>
  )
}

export function FieldsEditor({
  fields,
  onChange,
  vocabulary,
}: {
  fields: FieldDraft[]
  onChange: (next: FieldDraft[]) => void
  vocabulary: EditorVocabulary
}) {
  const [adding, setAdding] = useState('file')
  const typeLabel = (type: string) => vocabulary.fieldTypes.find((t) => t.value === type)?.label ?? type
  const update = (index: number, patch: Partial<FieldDraft>) =>
    onChange(fields.map((f, i) => (i === index ? { ...f, ...patch } : f)))
  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta
    if (target < 0 || target >= fields.length) return
    const next = [...fields]
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    onChange(next)
  }
  const inputCount = fields.filter((f) => vocabulary.inputFieldTypes.includes(f.type)).length

  return (
    <div className="space-y-3">
      {inputCount === 0 ? (
        <p className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
          還沒有可以填寫或上傳的欄位：{vocabulary.emptyCollectionMessage}。
        </p>
      ) : null}
      <ol className="space-y-2">
        {fields.map((f, index) => {
          const isInput = vocabulary.inputFieldTypes.includes(f.type)
          const choice = ['radio', 'checkbox', 'select'].includes(f.type)
          return (
            <li key={f.key} className="rounded-md border border-border p-3" data-field-type={f.type}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">{typeLabel(f.type)}</span>
                <label className="sr-only" htmlFor={`field-label-${f.key}`}>
                  第 {index + 1} 個欄位的{f.type === 'paragraph' ? '內容' : '標籤'}
                </label>
                <input
                  id={`field-label-${f.key}`}
                  className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm"
                  value={f.label}
                  placeholder={f.type === 'paragraph' ? '說明文字' : '欄位標籤'}
                  onChange={(e) => update(index, { label: e.target.value })}
                />
                {isInput ? (
                  <label className="inline-flex items-center gap-1 text-sm">
                    <input type="checkbox" checked={f.required} onChange={(e) => update(index, { required: e.target.checked })} />
                    必填
                  </label>
                ) : null}
                <button type="button" className={SECONDARY} onClick={() => move(index, -1)} disabled={index === 0} aria-label={`上移 ${f.label}`}>
                  ↑
                </button>
                <button
                  type="button"
                  className={SECONDARY}
                  onClick={() => move(index, 1)}
                  disabled={index === fields.length - 1}
                  aria-label={`下移 ${f.label}`}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className={SECONDARY}
                  onClick={() => onChange(fields.filter((_, i) => i !== index))}
                  aria-label={`刪除 ${f.label}`}
                >
                  刪除
                </button>
              </div>
              {isInput ? (
                <input
                  className="mt-2 w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
                  value={f.help}
                  placeholder="說明（選填），例如：100 字內"
                  aria-label={`${f.label} 的說明`}
                  onChange={(e) => update(index, { help: e.target.value })}
                />
              ) : null}
              {choice ? (
                <textarea
                  className="mt-2 w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
                  rows={3}
                  value={f.options.join('\n')}
                  aria-label={`${f.label} 的選項（一行一個）`}
                  onChange={(e) => update(index, { options: e.target.value.split('\n') })}
                />
              ) : null}
              {f.type === 'file' ? (
                <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
                  <span className="text-muted-foreground">允許類型</span>
                  {vocabulary.fileTypes.map((t) => (
                    <label key={t} className="inline-flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={f.allowedTypes.includes(t)}
                        onChange={(e) =>
                          update(index, {
                            allowedTypes: e.target.checked ? [...f.allowedTypes, t] : f.allowedTypes.filter((x) => x !== t),
                          })
                        }
                      />
                      {t}
                    </label>
                  ))}
                  <label className="inline-flex items-center gap-1">
                    上限
                    <input
                      type="number"
                      min={1}
                      max={vocabulary.fileMaxMiB}
                      className="w-20 rounded-md border border-border bg-background px-2 py-1 text-sm"
                      value={f.maxMiB}
                      onChange={(e) => update(index, { maxMiB: Number(e.target.value) })}
                    />
                    MiB
                  </label>
                </div>
              ) : null}
            </li>
          )
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="add-field-type">
          要新增的欄位類型
        </label>
        <select
          id="add-field-type"
          className="rounded-md border border-border bg-background px-3 py-1.5 text-sm"
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
        >
          {vocabulary.fieldTypes.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <button type="button" className={SECONDARY} onClick={() => onChange([...fields, newField(adding, typeLabel(adding))])}>
          新增欄位
        </button>
      </div>
    </div>
  )
}
