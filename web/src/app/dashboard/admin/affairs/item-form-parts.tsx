'use client'
import { useState } from 'react'
import { startItemUploadAction } from './actions'
import { formatSize, notifyPreviewText, type FileChip, type NotifyWhen } from './item-form-model'
import { IconPhoto } from '@tabler/icons-react'
import type { RecipientPreview } from '@/application/items'
import { BTN_OUTLINE, BTN_PRIMARY, DIALOG as KIT_DIALOG } from '@/app/_ui/dashboard-kit'
import { cn } from '@/shared/cn'

/** 欄位與上傳上限都用整數 MiB 設定；顯示時換成位元組交給共用的 `formatSize`（KB／MB）。 */
const MIB = 1024 * 1024

export {
  broadAudience,
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
 * 共用表單 `ItemForm`（C 階段規格① §2；`_form/*`）的零件：樣式、檔案上傳、封面、實際名單預覽（可展開）、正文預覽。
 *
 * 規則不在這裡判：名單與淨化後的正文都是伺服器 `reviewItemAction` 回來的，這裡只負責畫出來。
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
            封面只收 {accept.replaceAll(',', '、')}，上限 {formatSize(maxMiB * MIB)}。
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

// ── 名單 ────────────────────────────────────────────────────────────────────

/** 實際名單：先看總數，點開看到每一位（每一組）是誰（產品模組 04：不只總數）。 */
export function RecipientList({ recipients, notifyWhen }: { recipients: RecipientPreview; notifyWhen: NotifyWhen }) {
  if (recipients.receiverUnit === 'individual') {
    return (
      <details className="rounded-xl border border-border px-4 py-2.5 text-sm" data-testid="recipient-preview">
        <summary className="cursor-pointer font-semibold">
          需要繳交的名單：{recipients.people.length} 位學生（每人一份）
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
          需要繳交的名單：{recipients.groups.length} 組（每組一份，任一組員送出代表整組）
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
      {notifyPreviewText(recipients.notifyCount, notifyWhen)}
    </p>
  )
}

/** 正文：只吃伺服器清理過的 HTML（`review.bodyHtml`），不渲染使用者原字。 */
function ItemBody({ html, className }: { html: string; className?: string }) {
  return <div className={cn('prose-item space-y-2 leading-relaxed', className)} dangerouslySetInnerHTML={{ __html: html }} />
}

/**
 * 正文的即時預覽（系辦 AD-16；Q91 A）：只渲染伺服器淨化後的 `review.bodyHtml`，不直接渲染輸入框的原字（CSP 沒有 unsafe-inline、淨化在伺服器）。
 * 檢查沒過（例如還沒填標題）時不留上一版畫面，只寫原因。
 */
export function BodyPreview({ html, error }: { html: string | null; error: string | null }) {
  if (html === null || error) {
    return (
      <div className="text-sm text-muted-foreground">
        <p>開始打正文就會出現預覽</p>
        {/* 不用 alert／status：頁面其他地方已經有一份，同名的提示會讓「唯一那一則」變兩則。 */}
        {error ? <p className="mt-2 font-semibold text-destructive">{error}</p> : null}
      </div>
    )
  }
  if (html === '') return <p className="text-sm text-muted-foreground">正文還是空的。</p>
  return <ItemBody html={html} className="text-sm" />
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
