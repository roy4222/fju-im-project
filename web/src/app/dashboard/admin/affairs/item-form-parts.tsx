'use client'
import { useState } from 'react'
import { startItemUploadAction } from './actions'
import { formatSize, type EditorState, type EditorVocabulary, type FileChip } from './item-form-model'
import { IconAlertCircle, IconArrowDown, IconArrowUp, IconCheck, IconFileUpload, IconPaperclip, IconPhoto, IconX } from '@tabler/icons-react'
import type { ItemReview, PublishCheck, RecipientPreview } from '@/application/items'
import { BTN_ICON, BTN_OUTLINE, BTN_PRIMARY, DIALOG as KIT_DIALOG } from '@/app/_ui/dashboard-kit'
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

// 外觀照原型（票 35）：系網橘實心／白底細框按鈕、圓角 8px 的輸入框、原型 DialogContent 的對話框。
export const PRIMARY = BTN_PRIMARY
export const SECONDARY = BTN_OUTLINE
/** 輸入框與多行輸入共用（不定高度，多行的 rows 才有效）。 */
export const INPUT =
  'mt-1.5 min-h-10 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-normal outline-none ' +
  'transition-[border-color,box-shadow] focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/25 disabled:opacity-60'
export const LABEL = 'block text-sm font-semibold'

/**
 * 公告、資源發布時的「重要」勾選（Roy 2026-09-25 定）：勾了才逐人發站內通知給對象，一般公告只留發布紀錄。
 * 公開與所有登入者的對象＝全站有效帳號，預設不勾；其他對象（本屆學生、指定組別、全部老師）維持預設勾。
 */
export const IMPORTANT_LABEL = '重要公告：逐人發站內通知給對象'

export function broadAudience(audienceKind: string): boolean {
  return audienceKind === 'public' || audienceKind === 'signed_in'
}
export const DIALOG = cn(KIT_DIALOG, 'w-[min(44rem,calc(100vw-2rem))]')

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
    <div className="flex flex-col gap-2">
      {attachments.length > 0 ? (
        <ul className="flex flex-col gap-1.5" aria-label="附件">
          {attachments.map((a, index) => (
            <li key={a.fileId} className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background py-1 pr-1 pl-3 text-sm">
              <IconPaperclip aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <a href={`/api/files/${a.fileId}`} className="min-w-0 flex-1 truncate font-semibold underline-offset-2 hover:underline">
                {a.name}
              </a>
              <span className="text-xs text-muted-foreground tabular-nums">{formatSize(a.sizeBytes)}</span>
              <button type="button" className={BTN_ICON} onClick={() => move(index, -1)} disabled={disabled || index === 0} aria-label={`上移 ${a.name}`}>
                <IconArrowUp />
              </button>
              <button
                type="button"
                className={BTN_ICON}
                onClick={() => move(index, 1)}
                disabled={disabled || index === attachments.length - 1}
                aria-label={`下移 ${a.name}`}
              >
                <IconArrowDown />
              </button>
              <button
                type="button"
                className={cn(BTN_ICON, 'hover:bg-destructive-subtle hover:text-destructive')}
                onClick={() => onChange(attachments.filter((x) => x.fileId !== a.fileId))}
                disabled={disabled}
                aria-label={`移除 ${a.name}`}
              >
                <IconX />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {/* 原型「加入附件」：虛線框整塊可點。 */}
      <label
        className={cn(
          'flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-border px-4 py-3 text-left text-sm transition-colors hover:border-primary hover:bg-primary-subtle/30',
          (busy || disabled) && 'pointer-events-none opacity-50',
        )}
      >
        <IconFileUpload aria-hidden className="size-5 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          <span className="block font-semibold">{busy ? '上傳中…' : '加入附件'}</span>
          <span className="block text-xs text-muted-foreground">
            可上傳 {accept.replaceAll(',', '、')}，單檔上限 {maxMiB} MiB。下載權限跟著這一筆的對象走。
          </span>
        </span>
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
      {error ? (
        <p role="alert" className="rounded-lg bg-destructive-subtle px-3 py-2 text-sm font-semibold text-destructive-on-subtle">
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
    <div className="flex flex-col gap-2">
      {cover ? (
        <div className="flex flex-wrap items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- 封面走授權下載路由，不經 next/image 的最佳化快取 */}
          <img src={`/api/files/${cover.fileId}`} alt="封面預覽" className="h-20 w-32 rounded-lg border border-border object-cover" />
          <span className="text-sm font-semibold">{cover.name}</span>
          <button type="button" className={SECONDARY} onClick={() => onChange(null)} disabled={disabled}>
            移除封面
          </button>
        </div>
      ) : null}
      <label
        className={cn(
          'flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-border px-4 py-3 text-left text-sm transition-colors hover:border-primary hover:bg-primary-subtle/30',
          (busy || disabled) && 'pointer-events-none opacity-50',
        )}
      >
        <IconPhoto aria-hidden className="size-5 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          <span className="block font-semibold">{busy ? '上傳中…' : cover ? '換封面' : '上傳封面'}</span>
          <span className="block text-xs text-muted-foreground">
            封面只收 {accept.replaceAll(',', '、')}，上限 {maxMiB} MiB。
          </span>
        </span>
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
      {error ? (
        <p role="alert" className="rounded-lg bg-destructive-subtle px-3 py-2 text-sm font-semibold text-destructive-on-subtle">
          {error}
        </p>
      ) : null}
    </div>
  )
}

// ── 發布前檢查與名單 ────────────────────────────────────────────────────────

export function CheckList({ checks, onFix }: { checks: readonly PublishCheck[]; onFix?: (key: string) => void }) {
  return (
    <ul aria-label="發布前檢查" className="divide-y divide-border rounded-xl border border-border text-sm">
      {checks.map((c) => (
        <li
          key={c.key}
          data-check={c.key}
          data-ok={c.ok ? 'yes' : 'no'}
          className={cn('flex min-h-11 items-center gap-3 px-4 py-2', !c.ok && 'bg-destructive-subtle/40')}
        >
          <span
            aria-hidden
            className={cn(
              'inline-flex size-5 shrink-0 items-center justify-center rounded-full',
              c.ok ? 'bg-success text-success-foreground' : 'bg-destructive text-destructive-foreground',
            )}
          >
            {c.ok ? <IconCheck className="size-3" strokeWidth={3} /> : <IconAlertCircle className="size-3.5" />}
          </span>
          <span className="w-16 shrink-0 text-muted-foreground">{c.label}</span>
          <span className={cn('min-w-0 flex-1 font-semibold', !c.ok && 'text-destructive')}>{c.ok ? '沒問題' : c.fix}</span>
          {!c.ok && onFix ? (
            <button
              type="button"
              onClick={() => onFix(c.key)}
              className="shrink-0 text-xs font-semibold text-destructive underline-offset-2 hover:underline"
            >
              回去補<span className="sr-only">：{c.label}</span>
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

/** 實際名單：先看總數，點開看到每一位（每一組）是誰（產品模組 04：不只總數）。 */
export function RecipientList({ recipients }: { recipients: RecipientPreview }) {
  if (recipients.receiverUnit === 'individual') {
    return (
      <details className="rounded-xl border border-border px-4 py-2.5 text-sm" data-testid="recipient-preview">
        <summary className="cursor-pointer font-semibold">
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
      <details className="rounded-xl border border-border px-4 py-2.5 text-sm" data-testid="recipient-preview">
        <summary className="cursor-pointer font-semibold">
          收件名單：{recipients.groups.length} 組（每組一份，任一組員送出代表整組）
        </summary>
        {recipients.groups.length === 0 ? (
          <p className="mt-2 text-muted-foreground">對象裡目前沒有已成立的組別。</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {recipients.groups.map((g) => (
              <li key={g.groupId}>
                <span className="font-semibold tabular-nums">{g.code}</span>
                <span className="text-muted-foreground">：{g.members.length > 0 ? g.members.join('、') : '（沒有有效組員）'}</span>
              </li>
            ))}
          </ul>
        )}
      </details>
    )
  }
  return (
    <p className="rounded-xl border border-border px-4 py-2.5 text-sm" data-testid="recipient-preview">
      {recipients.notifyCount > 0 ? `通知會寫給 ${recipients.notifyCount} 位。` : '這個對象目前沒有可以通知的人。'}
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
    <article className="rounded-xl bg-muted/40 p-4 text-sm" aria-label="學生看到的樣子">
      <p className="text-xs font-bold tracking-[0.06em] text-muted-foreground">學生看到的樣子</p>
      <p className="mt-2 text-xs font-semibold text-muted-foreground">
        {placement}
        {review.deadlineText ? `・${review.deadlineText}` : ''}
      </p>
      <h3 className="mt-1 text-[17px] font-extrabold">{state.title || '（未命名）'}</h3>
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
                <span className="font-bold">{f.label}</span>
              ) : f.type === 'paragraph' ? (
                <span className="text-muted-foreground">{f.label}</span>
              ) : (
                <span>
                  {f.label}
                  {f.required ? <span className="ml-1 text-destructive">*</span> : null}
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
        'rounded-lg px-3 py-2 text-sm font-semibold',
        tone === 'ok' ? 'bg-success-subtle text-success-on-subtle' : 'bg-destructive-subtle text-destructive-on-subtle',
      )}
    >
      {children}
    </p>
  )
}
