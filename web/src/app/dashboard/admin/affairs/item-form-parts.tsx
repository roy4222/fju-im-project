'use client'
import { useState } from 'react'
import { startItemUploadAction } from './actions'
import { formatSize, type EditorState, type EditorVocabulary, type FileChip } from './item-form-model'
import type { ItemReview, PublishCheck, RecipientPreview } from '@/application/items'
import { cn } from '@/shared/cn'

export {
  fieldFromSchema,
  formatSize,
  newField,
  newFieldKey,
  newRequestId,
  toPayload,
  type EditorState,
  type EditorVocabulary,
  type FieldDraft,
  type FileChip,
  type Option,
} from './item-form-model'

/**
 * 快速建立（三步驟）與完整編輯器共用的零件（票 15）：編輯器狀態的形狀、轉成送給伺服器的內容、
 * 附件上傳、發布前檢查清單、實際名單預覽（可展開）、學生看到的樣子。
 *
 * 規則不在這裡判：檢查清單與名單都是伺服器 `reviewItemAction` 回來的，這裡只負責畫出來。
 */

// ── 樣式 ────────────────────────────────────────────────────────────────────

export const PRIMARY =
  'inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium ' +
  'text-primary-foreground hover:bg-primary/90 disabled:opacity-50'
export const SECONDARY =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border border-border px-3 py-1.5 ' +
  'text-sm font-medium text-ink hover:bg-muted disabled:opacity-50'
export const INPUT = 'mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm'
export const LABEL = 'block text-sm font-medium text-ink'
export const DIALOG =
  'm-auto w-[min(44rem,calc(100vw-2rem))] rounded-card border border-border bg-background p-0 backdrop:bg-ink/40'

// ── 上傳 ────────────────────────────────────────────────────────────────────

/** 先拿 ticket，再把位元組直接 POST 到 `/api/files/upload`（契約 02 §6；不經 Server Action）。 */
export async function uploadItemFile(
  file: File,
  cohortId: string,
  kind: 'attachment' | 'cover',
): Promise<{ ok: true; chip: FileChip } | { ok: false; message: string }> {
  try {
    const ticket = await startItemUploadAction({
      cohortId,
      kind,
      fileName: file.name,
      declaredMime: file.type,
      declaredSize: file.size,
    })
    if (!ticket.ok) return { ok: false, message: ticket.message }
    const response = await fetch(`/api/files/upload?ticket=${encodeURIComponent(ticket.data.ticket)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    })
    const uploaded = (await response.json().catch(() => null)) as
      | { ok: true; fileId: string; originalName: string; sizeBytes: number }
      | { ok: false; message: string }
      | null
    if (!uploaded || !uploaded.ok) return { ok: false, message: uploaded?.message ?? '上傳失敗，請重新選擇檔案。' }
    return { ok: true, chip: { fileId: uploaded.fileId, name: uploaded.originalName, sizeBytes: uploaded.sizeBytes } }
  } catch {
    return { ok: false, message: '連線中斷，請重新選擇檔案。' }
  }
}

export function AttachmentPicker({
  cohortId,
  attachments,
  onChange,
  accept,
  maxMiB,
  disabled,
}: {
  cohortId: string
  attachments: FileChip[]
  onChange: (next: FileChip[]) => void
  accept: string
  maxMiB: number
  disabled?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    setBusy(true)
    setError(null)
    const added: FileChip[] = []
    for (const file of Array.from(files)) {
      const result = await uploadItemFile(file, cohortId, 'attachment')
      if (!result.ok) {
        setError(`${file.name}：${result.message}`)
        break
      }
      added.push(result.chip)
    }
    onChange([...attachments, ...added])
    setBusy(false)
  }

  const move = (index: number, delta: -1 | 1) => {
    const next = [...attachments]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    onChange(next)
  }

  return (
    <div className="space-y-2">
      {attachments.length > 0 ? (
        <ul className="space-y-1" aria-label="附件">
          {attachments.map((a, index) => (
            <li key={a.fileId} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm">
              <a href={`/api/files/${a.fileId}`} className="min-w-0 flex-1 truncate font-medium text-ink underline-offset-2 hover:underline">
                {a.name}
              </a>
              <span className="text-xs text-muted-foreground tabular-nums">{formatSize(a.sizeBytes)}</span>
              <button type="button" className={SECONDARY} onClick={() => move(index, -1)} disabled={disabled || index === 0} aria-label={`上移 ${a.name}`}>
                ↑
              </button>
              <button
                type="button"
                className={SECONDARY}
                onClick={() => move(index, 1)}
                disabled={disabled || index === attachments.length - 1}
                aria-label={`下移 ${a.name}`}
              >
                ↓
              </button>
              <button
                type="button"
                className={SECONDARY}
                onClick={() => onChange(attachments.filter((x) => x.fileId !== a.fileId))}
                disabled={disabled}
                aria-label={`移除 ${a.name}`}
              >
                移除
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <label className={cn(SECONDARY, 'cursor-pointer', (busy || disabled) && 'pointer-events-none opacity-50')}>
        {busy ? '上傳中…' : '加入附件'}
        <input
          type="file"
          className="sr-only"
          multiple
          accept={accept}
          disabled={busy || disabled}
          onChange={(e) => {
            void onFiles(e.currentTarget.files)
            e.currentTarget.value = ''
          }}
        />
      </label>
      <p className="text-xs text-muted-foreground">
        可上傳 {accept.replaceAll(',', '、')}，單檔上限 {maxMiB} MiB。下載權限跟著發布對象走。
      </p>
      {error ? (
        <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export function CoverPicker({
  cohortId,
  cover,
  onChange,
  accept,
  maxMiB,
  disabled,
}: {
  cohortId: string
  cover: FileChip | null
  onChange: (next: FileChip | null) => void
  accept: string
  maxMiB: number
  disabled?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="space-y-2">
      {cover ? (
        <div className="flex flex-wrap items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- 封面走授權下載路由，不經 next/image 的最佳化快取 */}
          <img src={`/api/files/${cover.fileId}`} alt="封面預覽" className="h-20 w-32 rounded-md border border-border object-cover" />
          <span className="text-sm text-ink">{cover.name}</span>
          <button type="button" className={SECONDARY} onClick={() => onChange(null)} disabled={disabled}>
            移除封面
          </button>
        </div>
      ) : null}
      <label className={cn(SECONDARY, 'cursor-pointer', (busy || disabled) && 'pointer-events-none opacity-50')}>
        {busy ? '上傳中…' : cover ? '換封面' : '上傳封面'}
        <input
          type="file"
          className="sr-only"
          accept={accept}
          disabled={busy || disabled}
          onChange={async (e) => {
            const file = e.currentTarget.files?.[0]
            e.currentTarget.value = ''
            if (!file) return
            setBusy(true)
            setError(null)
            const result = await uploadItemFile(file, cohortId, 'cover')
            if (result.ok) onChange(result.chip)
            else setError(result.message)
            setBusy(false)
          }}
        />
      </label>
      <p className="text-xs text-muted-foreground">封面只收 {accept.replaceAll(',', '、')}，上限 {maxMiB} MiB。</p>
      {error ? (
        <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
          {error}
        </p>
      ) : null}
    </div>
  )
}

// ── 發布前檢查與名單 ────────────────────────────────────────────────────────

export function CheckList({ checks }: { checks: readonly PublishCheck[] }) {
  return (
    <ul aria-label="發布前檢查" className="divide-y divide-border rounded-md border border-border text-sm">
      {checks.map((c) => (
        <li
          key={c.key}
          data-check={c.key}
          data-ok={c.ok ? 'yes' : 'no'}
          className={cn('flex items-center gap-3 px-3 py-2', !c.ok && 'bg-danger-subtle')}
        >
          <span
            aria-hidden
            className={cn(
              'inline-flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-bold',
              c.ok ? 'bg-primary text-primary-foreground' : 'bg-danger text-primary-foreground',
            )}
          >
            {c.ok ? '✓' : '!'}
          </span>
          <span className="w-16 shrink-0 text-muted-foreground">{c.label}</span>
          <span className={cn('min-w-0 flex-1', c.ok ? 'text-ink' : 'font-medium text-danger-on-subtle')}>
            {c.ok ? '沒問題' : c.fix}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** 實際名單：先看總數，點開看到每一位（每一組）是誰（產品模組 04：不只總數）。 */
export function RecipientList({ recipients }: { recipients: RecipientPreview }) {
  if (recipients.receiverUnit === 'individual') {
    return (
      <details className="rounded-md border border-border px-3 py-2 text-sm" data-testid="recipient-preview">
        <summary className="cursor-pointer font-medium text-ink">
          收件名單：{recipients.people.length} 位學生（每人一份）
        </summary>
        {recipients.people.length === 0 ? (
          <p className="mt-2 text-muted-foreground">對象裡目前沒有符合資格的學生。</p>
        ) : (
          <ul className="mt-2 grid gap-1 sm:grid-cols-2">
            {recipients.people.map((p) => (
              <li key={p.userId} className="tabular-nums">
                {p.name}
                <span className="text-muted-foreground">
                  {p.studentNo ? `・${p.studentNo}` : ''}
                  {p.groupCode ? `・${p.groupCode}` : '・未分組'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </details>
    )
  }
  if (recipients.receiverUnit === 'group') {
    return (
      <details className="rounded-md border border-border px-3 py-2 text-sm" data-testid="recipient-preview">
        <summary className="cursor-pointer font-medium text-ink">
          收件名單：{recipients.groups.length} 組（每組一份，任一組員送出代表整組）
        </summary>
        {recipients.groups.length === 0 ? (
          <p className="mt-2 text-muted-foreground">對象裡目前沒有已成立的組別。</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {recipients.groups.map((g) => (
              <li key={g.groupId}>
                <span className="font-medium tabular-nums">{g.code}</span>
                <span className="text-muted-foreground">：{g.members.length > 0 ? g.members.join('、') : '（沒有有效組員）'}</span>
              </li>
            ))}
          </ul>
        )}
      </details>
    )
  }
  return (
    <p className="rounded-md border border-border px-3 py-2 text-sm text-ink" data-testid="recipient-preview">
      {recipients.notifyCount > 0 ? `通知會寫給 ${recipients.notifyCount} 位。` : '這個對象不逐人通知（公開或所有登入者只留發布紀錄）。'}
    </p>
  )
}

/** 學生（或訪客）看到的樣子：用伺服器清理過的正文。 */
export function StudentView({
  state,
  review,
  vocabulary,
}: {
  state: EditorState
  review: ItemReview
  vocabulary: EditorVocabulary
}) {
  const placement = vocabulary.placements.find((p) => p.value === state.placement)?.label ?? ''
  const typeLabel = (type: string) => vocabulary.fieldTypes.find((t) => t.value === type)?.label ?? type
  return (
    <article className="rounded-card border border-border bg-surface p-4 text-sm" aria-label="學生看到的樣子">
      <p className="text-xs font-semibold text-muted-foreground">
        {placement}
        {review.deadlineText ? `・${review.deadlineText}` : ''}
      </p>
      <h3 className="mt-1 text-lg font-semibold text-ink">{state.title || '（未命名）'}</h3>
      {state.summary ? <p className="mt-1 text-muted-foreground">{state.summary}</p> : null}
      {review.bodyHtml ? (
        <div className="prose-item mt-3 space-y-2 leading-relaxed" dangerouslySetInnerHTML={{ __html: review.bodyHtml }} />
      ) : null}
      {state.attachments.length > 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">附件：{state.attachments.map((a) => a.name).join('、')}</p>
      ) : null}
      {state.placement === 'submission' && state.fields.length > 0 ? (
        <ul className="mt-4 space-y-2 border-t border-border pt-3">
          {state.fields.map((f) => (
            <li key={f.key}>
              {f.type === 'heading' ? (
                <span className="font-semibold text-ink">{f.label}</span>
              ) : f.type === 'paragraph' ? (
                <span className="text-muted-foreground">{f.label}</span>
              ) : (
                <span>
                  {f.label}
                  {f.required ? <span className="ml-1 text-danger">*</span> : null}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {typeLabel(f.type)}
                    {f.type === 'file' ? `・${f.allowedTypes.join('、')}・上限 ${f.maxMiB} MiB` : ''}
                  </span>
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  )
}

export function Feedback({ tone, children }: { tone: 'ok' | 'error'; children: React.ReactNode }) {
  return (
    <p
      role={tone === 'ok' ? 'status' : 'alert'}
      className={cn(
        'rounded-md px-3 py-2 text-sm',
        tone === 'ok' ? 'bg-primary-subtle text-primary-on-subtle' : 'bg-danger-subtle text-danger-on-subtle',
      )}
    >
      {children}
    </p>
  )
}
