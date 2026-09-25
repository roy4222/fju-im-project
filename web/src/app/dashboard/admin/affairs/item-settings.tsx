'use client'
import { useState, type ReactNode } from 'react'
import {
  IconArrowDown,
  IconArrowUp,
  IconBell,
  IconBook,
  IconClipboardText,
  IconFolders,
  IconPlus,
  IconTrash,
  type Icon,
} from '@tabler/icons-react'
import { BTN_ICON } from '@/app/_ui/dashboard-kit'
import { INPUT, LABEL, newField, PRIMARY, SECONDARY, type EditorState, type EditorVocabulary, type FieldDraft } from './item-form-parts'
import { cn } from '@/shared/cn'

/**
 * 發布設定（位置、收件單位、對象、階段、開放與截止）與收件欄位編輯（票 15）。
 * 快速建立第 1 步與完整編輯器第 3 段用同一個元件，規則在伺服器判，這裡只收斂畫面上的選項。
 *
 * 外觀照原型（票 35）：發布位置是原型「新增項目」的類型卡片（圖示方塊＋名稱＋一句說明），
 * 單選類的選項是原型「公開範圍」那種框起來的圓鈕；欄位列表是「學生會看到的樣子」，點一欄原地展開設定。
 */

const PLACEMENT_ICON: Record<string, Icon> = {
  news: IconBell,
  resource: IconFolders,
  submission: IconClipboardText,
  rules: IconBook,
}

/** 原型「公開範圍」那種外框選項（radio／checkbox 都用）。 */
function choiceClass(on: boolean, locked = false) {
  return cn(
    'inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-semibold transition-colors',
    on ? 'border-primary bg-primary-subtle/40 text-primary-on-subtle' : 'border-border hover:border-primary/40',
    locked && 'cursor-not-allowed opacity-60',
  )
}

export function SettingsFields({
  state,
  onChange,
  vocabulary,
  published,
  unitLocked,
  idPrefix,
  afterPlacement,
}: {
  state: EditorState
  onChange: (patch: Partial<EditorState>) => void
  vocabulary: EditorVocabulary
  /** 已發布：不能換位置、不能改開放時間。 */
  published: boolean
  /** 有人作答：收件單位與對象鎖定。 */
  unitLocked: boolean
  idPrefix: string
  /** 放在發布位置卡片下面的欄位（快速建立的「標題」：原型順序是類型→標題→對象）。 */
  afterPlacement?: ReactNode
}) {
  const collects = state.placement === 'submission'
  const audiences = collects
    ? vocabulary.audiences.filter((a) => vocabulary.collectionAudiences.includes(a.value))
    : vocabulary.audiences
  const id = (name: string) => `${idPrefix}-${name}`

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <fieldset className="sm:col-span-2">
        <legend className={cn(LABEL, 'mb-1.5')}>發布位置（單選）</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {vocabulary.placements.map((p) => {
            const on = state.placement === p.value
            const PlacementIcon = PLACEMENT_ICON[p.value] ?? IconClipboardText
            return (
              <label
                key={p.value}
                className={cn(
                  'press flex cursor-pointer items-start gap-3 rounded-xl border-2 p-4 text-left transition-colors',
                  on ? 'border-primary bg-primary-subtle/40' : 'border-border hover:border-primary/40',
                  published && !on && 'cursor-not-allowed opacity-50',
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'inline-flex size-10 shrink-0 items-center justify-center rounded-lg',
                    on ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground',
                  )}
                >
                  <PlacementIcon className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm font-bold">
                    <input
                      type="radio"
                      name={id('placement')}
                      value={p.value}
                      checked={on}
                      disabled={published}
                      className="size-4 accent-primary"
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
                  {p.hint ? <span className="mt-0.5 block text-xs text-muted-foreground">{p.hint}</span> : null}
                </span>
              </label>
            )
          })}
        </div>
      </fieldset>

      {afterPlacement ? <div className="sm:col-span-2">{afterPlacement}</div> : null}

      {collects ? (
        <fieldset className="sm:col-span-2">
          <legend className={cn(LABEL, 'mb-1.5')}>收件單位</legend>
          <div className="flex flex-wrap gap-2">
            {vocabulary.units
              .filter((u) => u.value !== 'none')
              .map((u) => (
                <label key={u.value} className={choiceClass(state.receiverUnit === u.value, unitLocked)}>
                  <input
                    type="radio"
                    name={id('unit')}
                    value={u.value}
                    checked={state.receiverUnit === u.value}
                    disabled={unitLocked}
                    className="size-4 accent-primary"
                    onChange={() => onChange({ receiverUnit: u.value })}
                  />
                  {u.label}
                </label>
              ))}
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
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
        {collects ? <p className="mt-1.5 text-xs text-muted-foreground">收件只能發給本屆學生或指定組別。</p> : null}
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
            <p className="mt-1.5 text-xs font-semibold text-destructive">這一屆還沒設定階段，請先到時間軸設定。</p>
          ) : null}
        </div>
      ) : null}

      {state.audienceKind === 'groups' ? (
        <fieldset className="sm:col-span-2">
          <legend className={cn(LABEL, 'mb-1.5')}>
            指定組別 <span className="font-normal text-muted-foreground">・已選 {state.groupIds.length} 組</span>
          </legend>
          {vocabulary.groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">這一屆還沒有成立的組別。</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {vocabulary.groups.map((g) => {
                const on = state.groupIds.includes(g.id)
                return (
                  <label key={g.id} className={cn(choiceClass(on, unitLocked), 'tabular-nums')}>
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={unitLocked}
                      className="size-4 accent-primary"
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
            <p className="mt-1.5 text-xs text-muted-foreground">留空＝發布即開放；發布時會記下實際開放時間，之後不會重設。</p>
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
            <p className="mt-1.5 text-xs text-muted-foreground">例如 23:59：23:59:59 前送出都算準時，00:00 起就算遲交。</p>
          </div>
        </>
      ) : null}
    </div>
  )
}

// ── 收件欄位 ────────────────────────────────────────────────────────────────

/** 學生會看到的樣子（唯讀；原型 `FieldPreview`）。 */
function FieldPreview({ field: f, typeLabel }: { field: FieldDraft; typeLabel: string }) {
  const box = 'flex h-10 w-full items-center rounded-lg border border-input bg-muted/40 px-3 text-sm text-muted-foreground'
  if (f.type === 'heading') return <span className="block text-base font-bold">{f.label || '區段標題'}</span>
  if (f.type === 'paragraph') return <span className="block text-sm leading-relaxed text-muted-foreground">{f.label || '說明文字'}</span>
  const label = (
    <span className="block text-sm font-semibold">
      {f.label || <span className="text-muted-foreground">（未命名欄位）</span>}
      {f.required ? (
        <span className="ml-1 text-destructive" aria-hidden>
          *
        </span>
      ) : null}
      {f.help ? <span className="ml-2 text-xs font-normal text-muted-foreground">{f.help}</span> : null}
    </span>
  )
  let control: React.ReactNode
  if (f.type === 'textarea') control = <span className={cn(box, 'h-20 items-start py-2')} />
  else if (f.type === 'radio' || f.type === 'checkbox')
    control = (
      <span className="flex flex-wrap gap-x-5 gap-y-1.5">
        {f.options.map((o, i) => (
          <span key={i} className="inline-flex items-center gap-2 text-sm">
            <span className={cn('inline-block size-4 border border-input', f.type === 'radio' ? 'rounded-full' : 'rounded')} />
            {o || '（空白選項）'}
          </span>
        ))}
      </span>
    )
  else if (f.type === 'select') control = <span className={cn(box, 'justify-between')}>請選擇<span className="text-xs">▾</span></span>
  else if (f.type === 'file')
    control = (
      <span className="flex h-14 items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted-foreground">
        拖放或點擊上傳・{f.allowedTypes.join('、') || '不限'}・上限 {f.maxMiB} MiB
      </span>
    )
  else control = <span className={box}>{typeLabel}</span>
  return (
    <span className="flex flex-col gap-1.5">
      {label}
      {control}
    </span>
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
  // 原型：一次展開一欄的設定；剛新增的那一欄直接展開。
  const [editing, setEditing] = useState<string | null>(null)
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
  const add = () => {
    const field = newField(adding, typeLabel(adding))
    onChange([...fields, field])
    setEditing(field.key)
  }
  const inputCount = fields.filter((f) => vocabulary.inputFieldTypes.includes(f.type)).length

  const addBar = (primary: boolean) => (
    <div className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor="add-field-type">
        要新增的欄位類型
      </label>
      <select
        id="add-field-type"
        className="h-9 rounded-lg border border-input bg-background px-3 text-sm font-semibold outline-none focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/25"
        value={adding}
        onChange={(e) => setAdding(e.target.value)}
      >
        {vocabulary.fieldTypes.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>
      <button type="button" className={primary ? PRIMARY : SECONDARY} onClick={add}>
        <IconPlus aria-hidden /> 新增欄位
      </button>
    </div>
  )

  if (fields.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-4 text-center">
        <p className="text-sm font-semibold text-destructive">
          還沒有可以填寫或上傳的欄位：{vocabulary.emptyCollectionMessage}。
        </p>
        {addBar(true)}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {inputCount === 0 ? (
        <p className="rounded-lg bg-destructive-subtle px-3 py-2 text-sm font-semibold text-destructive-on-subtle">
          還沒有可以填寫或上傳的欄位：{vocabulary.emptyCollectionMessage}。
        </p>
      ) : null}
      <ol className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border">
        {fields.map((f, index) => {
          const isInput = vocabulary.inputFieldTypes.includes(f.type)
          const choice = ['radio', 'checkbox', 'select'].includes(f.type)
          const open = editing === f.key
          return (
            <li key={f.key} className={cn('transition-colors', open ? 'bg-primary-subtle/25' : 'hover:bg-accent/40')} data-field-type={f.type}>
              <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:gap-3">
                <button
                  type="button"
                  onClick={() => setEditing(open ? null : f.key)}
                  aria-expanded={open}
                  aria-label={`編輯欄位：${f.label || typeLabel(f.type)}`}
                  className="min-w-0 flex-1 text-left"
                >
                  <FieldPreview field={f} typeLabel={typeLabel(f.type)} />
                </button>
                <span className="flex shrink-0 items-center gap-0.5 self-end sm:self-start sm:pt-0.5">
                  <span className="mr-1 rounded bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">{typeLabel(f.type)}</span>
                  <button type="button" className={BTN_ICON} onClick={() => move(index, -1)} disabled={index === 0} aria-label={`上移 ${f.label}`}>
                    <IconArrowUp />
                  </button>
                  <button
                    type="button"
                    className={BTN_ICON}
                    onClick={() => move(index, 1)}
                    disabled={index === fields.length - 1}
                    aria-label={`下移 ${f.label}`}
                  >
                    <IconArrowDown />
                  </button>
                  <button
                    type="button"
                    className={cn(BTN_ICON, 'hover:bg-destructive-subtle hover:text-destructive')}
                    onClick={() => onChange(fields.filter((_, i) => i !== index))}
                    aria-label={`刪除 ${f.label}`}
                  >
                    <IconTrash />
                  </button>
                </span>
              </div>
              {open ? (
                <div className="grid gap-3 border-t border-border/70 px-4 pt-3 pb-4 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <label className="text-xs font-semibold text-muted-foreground" htmlFor={`field-label-${f.key}`}>
                      <span className="sr-only">第 {index + 1} 個欄位的</span>
                      {f.type === 'paragraph' ? '內容' : '標籤'}
                    </label>
                    <input
                      id={`field-label-${f.key}`}
                      className={INPUT}
                      value={f.label}
                      placeholder={f.type === 'paragraph' ? '說明文字' : '欄位標籤'}
                      onChange={(e) => update(index, { label: e.target.value })}
                    />
                  </div>
                  {isInput ? (
                    <div>
                      <label className="text-xs font-semibold text-muted-foreground" htmlFor={`field-help-${f.key}`}>
                        說明
                      </label>
                      <input
                        id={`field-help-${f.key}`}
                        className={INPUT}
                        value={f.help}
                        placeholder="例：100 字內"
                        onChange={(e) => update(index, { help: e.target.value })}
                      />
                    </div>
                  ) : null}
                  {choice ? (
                    <div className="sm:col-span-2">
                      <label className="text-xs font-semibold text-muted-foreground" htmlFor={`field-options-${f.key}`}>
                        選項（一行一個）
                      </label>
                      <textarea
                        id={`field-options-${f.key}`}
                        className={INPUT}
                        rows={3}
                        value={f.options.join('\n')}
                        onChange={(e) => update(index, { options: e.target.value.split('\n') })}
                      />
                    </div>
                  ) : null}
                  {f.type === 'file' ? (
                    <fieldset className="sm:col-span-2">
                      <legend className="text-xs font-semibold text-muted-foreground">允許類型與上限</legend>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
                        {vocabulary.fileTypes.map((t) => {
                          const on = f.allowedTypes.includes(t)
                          return (
                            <label key={t} className={choiceClass(on)}>
                              <input
                                type="checkbox"
                                checked={on}
                                className="size-4 accent-primary"
                                onChange={(e) =>
                                  update(index, {
                                    allowedTypes: e.target.checked ? [...f.allowedTypes, t] : f.allowedTypes.filter((x) => x !== t),
                                  })
                                }
                              />
                              {t}
                            </label>
                          )
                        })}
                        <label className="inline-flex items-center gap-1.5 font-semibold">
                          上限
                          <input
                            type="number"
                            min={1}
                            max={vocabulary.fileMaxMiB}
                            className="h-10 w-20 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-primary"
                            value={f.maxMiB}
                            onChange={(e) => update(index, { maxMiB: Number(e.target.value) })}
                          />
                          MiB
                        </label>
                      </div>
                    </fieldset>
                  ) : null}
                  {isInput ? (
                    <label className="flex min-h-10 items-center gap-2 text-sm font-semibold">
                      <input type="checkbox" checked={f.required} className="size-4 accent-primary" onChange={(e) => update(index, { required: e.target.checked })} />
                      必填
                    </label>
                  ) : null}
                  <div className="flex justify-end sm:col-span-2">
                    <button type="button" className={SECONDARY} onClick={() => setEditing(null)}>
                      完成
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          )
        })}
      </ol>
      <div className="flex justify-end">{addBar(false)}</div>
    </div>
  )
}
