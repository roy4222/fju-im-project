'use client'
import { useEffect, useRef, useState } from 'react'
import { IconCloudUpload, IconPaperclip } from '@tabler/icons-react'
import type { FormField } from '@/application/items'
import { acceptOf, checkPickedFile, DEFAULT_FILE_RULES, limitText } from '@/app/dashboard/_submissions/file-size-guard'
import { cn } from '@/shared/cn'
import { formatBytes } from '@/shared/format-bytes'

/**
 * 交作業的欄位渲染（C 階段規格① §5.2 `SubmissionFields`）：照作業的欄位結構畫出每一欄。
 * 學生、老師的「寫作業」表單用它（可填）；系辦新增表單的「即時預覽：學生看到的樣子」也用它（`preview`：只有樣子、不能操作）。
 *
 * - 值、已附上的檔、上傳進度都由呼叫端管；這裡只畫，改動經 `onChange`／`onPickFile` 回報。
 * - 檔案欄：選檔的 `change` 當下先過 `checkPickedFile`（大小與類型，讀欄位的 `fileRules`），不合就清掉選擇、
 *   在欄位下紅字說明，**不**呼叫 `onPickFile`（不要上傳憑證、不送位元組）。合格才交給呼叫端上傳。
 * - `carriedOver`：草稿裡帶過來的檔（上次上傳、還沒送出）標「上次選的檔案」。
 */

export type FieldValue = string | string[]

/** 一個已附上的檔（檔案 ID → 檔名與大小）。 */
export type AttachedFile = { name: string; sizeBytes: number }

export type FieldUpload = { status: 'uploading'; percent: number; name: string } | { status: 'error'; message: string }

// 外觀照原型 `group-form.tsx`（票 38）：次要鈕白底細框；輸入框 44px 高、橘色焦點環。
export const SECONDARY_BUTTON =
  'press inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-border bg-background px-4 text-sm font-medium ' +
  'text-foreground transition-colors hover:bg-muted disabled:opacity-50 [&_svg]:size-4'
const CONTROL =
  'h-11 w-full rounded-lg border bg-background px-3 text-sm outline-none transition-[border-color,box-shadow] ' +
  'focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25 disabled:bg-muted disabled:text-muted-foreground'

export function SubmissionFields({
  fields,
  values,
  files = {},
  uploads = {},
  readOnly = false,
  preview = false,
  badFields = [],
  carriedOver = [],
  onChange,
  onPickFile,
}: {
  fields: readonly FormField[]
  values: Readonly<Record<string, FieldValue>>
  /** 已附上的檔（檔案 ID → 檔名與大小）。 */
  files?: Readonly<Record<string, AttachedFile>>
  uploads?: Readonly<Record<string, FieldUpload>>
  readOnly?: boolean
  /** 只畫樣子（系辦表單預覽）：所有輸入停用、沒有下載連結。 */
  preview?: boolean
  badFields?: readonly string[]
  /** 從草稿帶過來的檔案欄（標「上次選的檔案」）。 */
  carriedOver?: readonly string[]
  onChange?: (key: string, value: FieldValue) => void
  onPickFile?: (field: FormField, file: File) => void
}) {
  const locked = readOnly || preview
  return (
    <>
      {fields.map((field) =>
        field.type === 'file' ? (
          <FileInput
            key={field.key}
            field={field}
            fileId={typeof values[field.key] === 'string' ? (values[field.key] as string) : ''}
            files={files}
            upload={uploads[field.key]}
            readOnly={locked}
            preview={preview}
            bad={badFields.includes(field.key)}
            carriedOver={carriedOver.includes(field.key)}
            onPick={(file) => onPickFile?.(field, file)}
            onRemove={() => onChange?.(field.key, '')}
          />
        ) : (
          <FieldInput
            key={field.key}
            field={field}
            value={values[field.key]}
            readOnly={locked}
            bad={badFields.includes(field.key)}
            onChange={(v) => onChange?.(field.key, v)}
          />
        ),
      )}
    </>
  )
}

function FieldLabel({ field, htmlFor, hint }: { field: FormField; htmlFor: string; hint?: string }) {
  return (
    <label htmlFor={htmlFor} className="block text-sm font-semibold">
      {field.label}
      {field.required ? (
        <span className="ml-1 text-destructive" aria-hidden>
          *
        </span>
      ) : null}
      {field.help ? <span className="ml-2 text-xs font-normal text-muted-foreground">{field.help}</span> : null}
      {hint ? <span className="ml-2 text-xs font-normal text-muted-foreground">{hint}</span> : null}
    </label>
  )
}

/** 上傳進度條：寬度用 CSSOM 設（CSP 不允許 `style=` 屬性）。 */
function ProgressBar({ percent }: { percent: number }) {
  const bar = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bar.current?.style.setProperty('width', `${percent}%`)
  }, [percent])
  return (
    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
      <div ref={bar} className="h-full w-0 rounded-full bg-brand transition-[width]" />
    </div>
  )
}

/** 檔案欄位：上傳區、選檔預檢、進度、已附上的檔（可下載、可換、可移除）、錯誤說明。 */
function FileInput({
  field,
  fileId,
  files,
  upload,
  readOnly,
  preview,
  bad,
  carriedOver,
  onPick,
  onRemove,
}: {
  field: FormField
  fileId: string
  files: Readonly<Record<string, AttachedFile>>
  upload: FieldUpload | undefined
  readOnly: boolean
  preview: boolean
  bad: boolean
  carriedOver: boolean
  onPick: (file: File) => void
  onRemove: () => void
}) {
  const id = `field-${field.key}`
  const rules = field.fileRules ?? DEFAULT_FILE_RULES
  const accept = acceptOf(rules)
  const [pickError, setPickError] = useState<string | null>(null)
  const attached = fileId ? files[fileId] : undefined

  /** 選檔的當下：不合就清掉選擇、寫紅字，不交給呼叫端（不上傳）。 */
  function onInput(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    const problem = checkPickedFile(file, rules)
    if (problem) {
      event.target.value = ''
      setPickError(problem)
      return
    }
    setPickError(null)
    onPick(file)
    // 同一個檔再選一次也要觸發 change（例如上傳失敗後重選）。
    event.target.value = ''
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid={`file-field-${field.key}`}>
      <FieldLabel field={field} htmlFor={id} hint={limitText(rules)} />
      {attached ? (
        <div className={cn('flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-sm', bad ? 'border-destructive' : 'border-border')}>
          <IconPaperclip className="size-4 shrink-0 text-brand" aria-hidden />
          <a href={`/api/files/${fileId}`} className="min-w-0 break-all font-semibold text-ink underline-offset-2 hover:underline">
            {attached.name}
          </a>
          <span className="text-xs text-muted-foreground tabular-nums">{formatBytes(attached.sizeBytes)}</span>
          {carriedOver ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground" data-testid={`carried-over-${field.key}`}>
              上次選的檔案
            </span>
          ) : null}
          {!readOnly ? (
            <span className="ml-auto flex gap-2">
              <label className={cn(SECONDARY_BUTTON, 'h-9 cursor-pointer px-3 text-xs')}>
                換檔案
                <input id={id} type="file" className="sr-only" accept={accept} onChange={onInput} />
              </label>
              <button type="button" className={cn(SECONDARY_BUTTON, 'h-9 px-3 text-xs')} onClick={onRemove}>
                移除
              </button>
            </span>
          ) : null}
        </div>
      ) : (
        <label
          className={cn(
            'flex min-h-11 items-center gap-3 rounded-lg border border-dashed px-4 py-3 text-sm transition-colors',
            bad || pickError ? 'border-destructive' : 'border-border',
            readOnly ? 'pointer-events-none cursor-not-allowed opacity-60' : 'cursor-pointer hover:border-brand hover:bg-brand-subtle/30',
          )}
        >
          <IconCloudUpload className="size-5 shrink-0 text-brand" aria-hidden />
          <span className="font-semibold">{readOnly && !preview ? '沒有附檔' : '點擊選擇檔案上傳'}</span>
          <input
            id={id}
            type="file"
            className="sr-only"
            accept={accept}
            disabled={readOnly}
            aria-invalid={bad || pickError !== null || undefined}
            aria-required={field.required || undefined}
            aria-describedby={pickError ? `${id}-error` : undefined}
            onChange={onInput}
          />
        </label>
      )}
      {pickError ? (
        <p id={`${id}-error`} role="alert" className="text-sm font-semibold text-destructive" data-testid={`pick-error-${field.key}`}>
          {pickError}
        </p>
      ) : null}
      {upload?.status === 'uploading' ? (
        <div className="mt-1" role="status" aria-live="polite" data-testid={`upload-progress-${field.key}`}>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span className="truncate">正在上傳 {upload.name}</span>
            <span className="tabular-nums">{upload.percent}%</span>
          </div>
          <ProgressBar percent={upload.percent} />
        </div>
      ) : null}
      {upload?.status === 'error' ? (
        <p role="alert" className="rounded-lg bg-destructive-subtle px-4 py-2.5 text-sm text-destructive-on-subtle" data-testid={`upload-error-${field.key}`}>
          {upload.message}
        </p>
      ) : null}
    </div>
  )
}

function FieldInput({
  field,
  value,
  readOnly,
  bad,
  onChange,
}: {
  field: FormField
  value: FieldValue | undefined
  readOnly: boolean
  bad: boolean
  onChange: (value: FieldValue) => void
}) {
  const id = `field-${field.key}`
  const text = typeof value === 'string' ? value : ''
  const picked = Array.isArray(value) ? value : []
  const border = bad ? 'border-destructive focus-visible:border-destructive focus-visible:ring-destructive/25' : 'border-input'
  const aria = { 'aria-invalid': bad || undefined, 'aria-required': field.required || undefined }
  const label = <FieldLabel field={field} htmlFor={id} />

  switch (field.type) {
    case 'heading':
      return <h3 className="mt-2 border-b border-border pb-2 text-base font-bold">{field.label}</h3>
    case 'paragraph':
      return <p className="border-l-[3px] border-border pl-3 text-sm leading-relaxed text-muted-foreground">{field.label}</p>
    case 'textarea':
      return (
        <div className="flex flex-col gap-1.5">
          {label}
          <textarea
            id={id}
            rows={5}
            className={cn(CONTROL, 'h-auto resize-y py-2.5', border)}
            value={text}
            disabled={readOnly}
            onChange={(e) => onChange(e.target.value)}
            {...aria}
          />
        </div>
      )
    case 'radio':
    case 'checkbox':
      return (
        <fieldset aria-invalid={bad || undefined} className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-semibold">
            {field.label}
            {field.required ? (
              <span className="ml-1 text-destructive" aria-hidden>
                *
              </span>
            ) : null}
          </legend>
          <div className="flex flex-wrap gap-2">
            {(field.options ?? []).map((option, index) => {
              const checked = field.type === 'radio' ? text === option : picked.includes(option)
              return (
                <label
                  key={option}
                  className={cn(
                    'inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors',
                    checked ? 'border-brand bg-brand-subtle/50' : bad ? 'border-destructive' : 'border-border',
                  )}
                >
                  <input
                    type={field.type}
                    id={index === 0 ? id : undefined}
                    name={field.key}
                    checked={checked}
                    disabled={readOnly}
                    className="accent-[var(--color-primary)]"
                    onChange={() =>
                      onChange(
                        field.type === 'radio'
                          ? option
                          : checked
                            ? picked.filter((p) => p !== option)
                            : [...picked, option],
                      )
                    }
                  />
                  {option}
                </label>
              )
            })}
          </div>
        </fieldset>
      )
    case 'select':
      return (
        <div className="flex flex-col gap-1.5">
          {label}
          <select id={id} className={cn(CONTROL, border)} value={text} disabled={readOnly} onChange={(e) => onChange(e.target.value)} {...aria}>
            <option value="">請選擇</option>
            {(field.options ?? []).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
      )
    default: {
      const type = { number: 'text', email: 'email', url: 'url', date: 'date', time: 'time' }[field.type as string] ?? 'text'
      return (
        <div className="flex flex-col gap-1.5">
          {label}
          <input
            id={id}
            type={type}
            inputMode={field.type === 'number' ? 'decimal' : undefined}
            className={cn(CONTROL, border)}
            value={text}
            disabled={readOnly}
            onChange={(e) => onChange(e.target.value)}
            {...aria}
          />
        </div>
      )
    }
  }
}
