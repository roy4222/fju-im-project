'use client'
import { useRef, useState } from 'react'
import { IconArrowDown, IconArrowUp, IconCheck, IconDots, IconGripVertical, IconLock, IconPlus, IconTrash } from '@tabler/icons-react'
import { BTN_ICON } from '@/app/_ui/dashboard-kit'
import { INPUT, LABEL, SECONDARY } from '@/app/dashboard/admin/affairs/item-form-parts'
import {
  fieldFromSchema,
  fieldLock,
  lockedFieldsNotice,
  MAIN_FIELD_TYPES,
  MAX_FIELDS,
  MORE_FIELD_TYPES,
  moveField,
  newField,
  shiftField,
  type ConsentModeValue,
  type EditorVocabulary,
  type FieldDraft,
} from '@/app/dashboard/admin/affairs/item-form-model'
import type { ItemTemplate } from '@/application/items'
import { cn } from '@/shared/cn'

/**
 * 拖拉式表單產生器（C 階段規格① §2.4、A13）：每列「拖柄｜型別｜欄名｜必填｜⋯（說明、選項、檔案規則）｜上移／下移｜刪除」，底部「＋ 新增欄位」。
 *
 * - 拖曳是原生 HTML5 drag（不裝套件，§0.3）：拖哪一列記在 ref，`drop` 時用 `moveField` 算新順序，不依賴 `dataTransfer` 的內容；
 *   鍵盤與手機用每列的「上移／下移」。放下就回報新陣列，右欄預覽跟著重畫。
 * - 型別清單＝既有 `FIELD_TYPES`：常用 8 種在前，其他在「更多型別」。
 * - 有人交過：結構鎖住（型別、必填、選項、檔案規則、順序、刪除、新增），只能改欄名與說明（AC-5）；
 *   下載再上傳的同意書，「簽好的同意書」那欄不能刪（AC-24）。
 * - 收件範本（第三波 W12）：按一下補上整組欄位（代號已在的跳過），繳交方式改成範本的單位。
 */

const CHOICE = ['radio', 'checkbox', 'select']
const STATIC = ['heading', 'paragraph']

export function FieldBuilder({
  fields,
  onChange,
  vocabulary,
  hasResponses,
  responseCount,
  receiverUnit,
  consentMode,
  templates = [],
  onTemplate,
  error,
}: {
  fields: readonly FieldDraft[]
  onChange: (next: FieldDraft[]) => void
  vocabulary: EditorVocabulary
  hasResponses: boolean
  responseCount: number | null
  receiverUnit: string
  consentMode: ConsentModeValue | null
  templates?: readonly ItemTemplate[]
  /** 套用範本：表單把欄位補上、繳交方式改成範本的單位；回傳結果句。 */
  onTemplate?: (template: ItemTemplate, added: FieldDraft[]) => string
  /** 必填檢查的紅字（例如還沒有可以填寫或上傳的欄位）。 */
  error?: string
}) {
  const [adding, setAdding] = useState<string>('file')
  const [open, setOpen] = useState<string | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const [templateNote, setTemplateNote] = useState<string | null>(null)
  const dragFrom = useRef<number | null>(null)
  const locked = hasResponses
  const typeLabel = (type: string) => vocabulary.fieldTypes.find((t) => t.value === type)?.label ?? type
  const update = (index: number, patch: Partial<FieldDraft>) => onChange(fields.map((f, i) => (i === index ? { ...f, ...patch } : f)))
  const full = fields.length >= MAX_FIELDS

  function add() {
    const field = newField(adding, typeLabel(adding))
    onChange([...fields, field])
    setOpen(null)
  }

  function applyTemplate(template: ItemTemplate) {
    const taken = new Set(fields.map((f) => f.key))
    const added = template.fields.filter((f) => !taken.has(f.key)).map(fieldFromSchema)
    if (onTemplate) setTemplateNote(onTemplate(template, added))
  }

  const typeOptions = (
    <>
      {MAIN_FIELD_TYPES.map((t) => (
        <option key={t} value={t}>
          {typeLabel(t)}
        </option>
      ))}
      <optgroup label="更多型別">
        {MORE_FIELD_TYPES.map((t) => (
          <option key={t} value={t}>
            {typeLabel(t)}
          </option>
        ))}
      </optgroup>
    </>
  )

  return (
    <section aria-labelledby="sec-fields" className="flex flex-col gap-3" data-testid="field-builder">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h3 id="sec-fields" className={LABEL}>
          繳交欄位
        </h3>
        <span className="text-xs text-muted-foreground">學生「寫作業」照這個順序看到；拖左邊的握把或按上移／下移排序</span>
      </div>
      {locked ? (
        <p className="flex items-center gap-1.5 rounded-lg bg-muted px-3 py-2 text-sm font-semibold" data-testid="fields-locked">
          <IconLock aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          {lockedFieldsNotice(responseCount, receiverUnit)}
        </p>
      ) : null}

      {!locked && templates.length > 0 ? (
        <div className="flex w-full flex-col gap-2" data-testid="item-templates">
          {templates.map((t) => (
            <div key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <button type="button" className={SECONDARY} onClick={() => applyTemplate(t)}>
                {t.label}
              </button>
              <span className="text-xs text-muted-foreground">{t.description}</span>
            </div>
          ))}
          <p className="flex items-center gap-1.5 text-xs font-semibold empty:hidden" aria-live="polite" data-testid="template-note">
            {templateNote ? (
              <>
                <IconCheck aria-hidden className="size-3.5 text-primary" />
                {templateNote}
              </>
            ) : null}
          </p>
        </div>
      ) : null}

      {fields.length > 0 ? (
        <ol className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border" aria-label="繳交欄位清單">
          {fields.map((f, index) => {
            const lock = fieldLock(f, { hasResponses, consentMode })
            const isInput = vocabulary.inputFieldTypes.includes(f.type)
            const expanded = open === f.key
            const name = f.label || typeLabel(f.type)
            return (
              <li
                key={f.key}
                data-field-type={f.type}
                data-field-key={f.key}
                draggable={!lock.structure}
                onDragStart={(e) => {
                  dragFrom.current = index
                  e.dataTransfer.effectAllowed = 'move'
                  // Firefox 要有資料才會開始拖；內容不用（放下時看 ref）。
                  e.dataTransfer.setData('text/plain', f.key)
                }}
                onDragOver={(e) => {
                  if (dragFrom.current === null) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  if (over !== index) setOver(index)
                }}
                onDragLeave={() => setOver((o) => (o === index ? null : o))}
                onDrop={(e) => {
                  e.preventDefault()
                  const from = dragFrom.current
                  dragFrom.current = null
                  setOver(null)
                  if (from !== null && !lock.structure) onChange(moveField(fields, from, index))
                }}
                onDragEnd={() => {
                  dragFrom.current = null
                  setOver(null)
                }}
                className={cn('bg-background transition-colors', expanded && 'bg-primary-subtle/25', over === index && 'bg-primary-subtle/50')}
              >
                <div className="flex flex-wrap items-center gap-2 px-2 py-2 sm:flex-nowrap">
                  <span
                    aria-hidden
                    data-testid="drag-handle"
                    className={cn('inline-flex size-8 shrink-0 items-center justify-center rounded text-muted-foreground', lock.structure ? 'opacity-30' : 'cursor-grab')}
                  >
                    <IconGripVertical className="size-4" />
                  </span>
                  <label className="sr-only" htmlFor={`field-type-${f.key}`}>
                    第 {index + 1} 個欄位的型別
                  </label>
                  <select
                    id={`field-type-${f.key}`}
                    className="h-9 w-28 shrink-0 rounded-lg border border-input bg-background px-2 text-sm font-semibold outline-none focus-visible:border-primary disabled:opacity-60"
                    value={f.type}
                    disabled={lock.structure || !lock.removable}
                    onChange={(e) => {
                      const type = e.target.value
                      update(index, {
                        type,
                        required: STATIC.includes(type) ? false : f.required,
                        options: CHOICE.includes(type) && f.options.length === 0 ? ['選項 1', '選項 2'] : f.options,
                      })
                    }}
                  >
                    {typeOptions}
                  </select>
                  <label className="sr-only" htmlFor={`field-label-${f.key}`}>
                    第 {index + 1} 個欄位的{f.type === 'paragraph' ? '內容' : '欄名'}
                  </label>
                  <input
                    id={`field-label-${f.key}`}
                    className="h-9 min-w-0 flex-1 basis-40 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-primary"
                    value={f.label}
                    placeholder={f.type === 'paragraph' ? '說明文字' : '欄名'}
                    onChange={(e) => update(index, { label: e.target.value })}
                  />
                  {isInput ? (
                    <label className="flex shrink-0 items-center gap-1.5 text-xs font-semibold">
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        checked={f.required}
                        disabled={lock.structure}
                        onChange={(e) => update(index, { required: e.target.checked })}
                      />
                      必填<span className="sr-only">：{name}</span>
                    </label>
                  ) : null}
                  <span className="ml-auto flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      className={BTN_ICON}
                      onClick={() => setOpen(expanded ? null : f.key)}
                      aria-expanded={expanded}
                      aria-label={`編輯欄位：${name}`}
                    >
                      <IconDots />
                    </button>
                    <button
                      type="button"
                      className={BTN_ICON}
                      onClick={() => onChange(shiftField(fields, index, -1))}
                      disabled={lock.structure || index === 0}
                      aria-label={`上移 ${name}`}
                    >
                      <IconArrowUp />
                    </button>
                    <button
                      type="button"
                      className={BTN_ICON}
                      onClick={() => onChange(shiftField(fields, index, 1))}
                      disabled={lock.structure || index === fields.length - 1}
                      aria-label={`下移 ${name}`}
                    >
                      <IconArrowDown />
                    </button>
                    <button
                      type="button"
                      className={cn(BTN_ICON, 'hover:bg-destructive-subtle hover:text-destructive')}
                      onClick={() => onChange(fields.filter((_, i) => i !== index))}
                      disabled={!lock.removable}
                      aria-label={`刪除 ${name}`}
                    >
                      <IconTrash />
                    </button>
                  </span>
                </div>
                {expanded ? (
                  <div className="grid gap-3 border-t border-border/70 px-4 pt-3 pb-4 sm:grid-cols-2">
                    {isInput ? (
                      <div className="sm:col-span-2">
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
                    {CHOICE.includes(f.type) ? (
                      <div className="sm:col-span-2">
                        <label className="text-xs font-semibold text-muted-foreground" htmlFor={`field-options-${f.key}`}>
                          選項（一行一個）
                        </label>
                        <textarea
                          id={`field-options-${f.key}`}
                          className={INPUT}
                          rows={3}
                          value={f.options.join('\n')}
                          disabled={lock.structure}
                          onChange={(e) => update(index, { options: e.target.value.split('\n') })}
                        />
                      </div>
                    ) : null}
                    {f.type === 'file' ? (
                      <fieldset className="sm:col-span-2" disabled={lock.structure}>
                        <legend className="text-xs font-semibold text-muted-foreground">允許類型與上限（學生選檔當下就照這個擋）</legend>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
                          {vocabulary.fileTypes.map((t) => {
                            const on = f.allowedTypes.includes(t)
                            return (
                              <label
                                key={t}
                                className={cn(
                                  'inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-lg border px-3 py-1 text-sm font-semibold',
                                  on ? 'border-primary bg-primary-subtle text-primary-on-subtle' : 'border-border',
                                )}
                              >
                                <input
                                  type="checkbox"
                                  checked={on}
                                  className="size-4 accent-primary"
                                  onChange={(e) =>
                                    update(index, { allowedTypes: e.target.checked ? [...f.allowedTypes, t] : f.allowedTypes.filter((x) => x !== t) })
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
                              className="h-9 w-20 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-primary"
                              value={f.maxMiB}
                              onChange={(e) => update(index, { maxMiB: Number(e.target.value) })}
                            />
                            MB
                          </label>
                        </div>
                      </fieldset>
                    ) : null}
                    {!isInput && !CHOICE.includes(f.type) && f.type !== 'file' ? (
                      <p className="text-xs text-muted-foreground sm:col-span-2">
                        {STATIC.includes(f.type) ? '只給學生看的文字，不用填。' : '這一欄沒有其他設定。'}
                      </p>
                    ) : null}
                    <div className="flex justify-end sm:col-span-2">
                      <button type="button" className={SECONDARY} onClick={() => setOpen(null)}>
                        完成
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ol>
      ) : null}

      {error ? (
        <p id="err-fields" className="text-sm font-semibold text-destructive" data-error="fields">
          {error}
        </p>
      ) : null}

      {!locked ? (
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
            {typeOptions}
          </select>
          <button type="button" className={SECONDARY} onClick={add} disabled={full}>
            <IconPlus aria-hidden /> 新增欄位
          </button>
          {full ? <span className="text-xs text-muted-foreground">最多 {MAX_FIELDS} 欄。</span> : null}
        </div>
      ) : null}
    </section>
  )
}
