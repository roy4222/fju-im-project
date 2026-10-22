'use client'
import { useState } from 'react'
import { formatSize, itemFormDeps, notifyPreviewText, type FileChip, type NotifyWhen } from './item-form-model'
import { createReactComponent, IconPhoto } from '@tabler/icons-react'
import type { RecipientPreview } from '@/application/items'

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
//
// 這裡和 `_form/*` 刻意**不 import `dashboard-kit`、`@/shared/cn`、首頁也用到的 tabler 圖示與 `AvatarImg`**：表單本體是按需載入的
// async chunk（`_form/item-form-dialog.tsx`），只要它靜態碰到「每頁首載都有」的模組，Turbopack 就把那幾個模組從共用 chunk
// 拆成另一塊，所有路由的 gzip 都變大（C1-06 實測 `$shared` +1.0 KB；同 `tiptap-editor.tsx` 的 `cx`、C2-17 `forms/registry.ts`）。
// 所以樣式寫成字面字串（下列字串＝`dashboard-kit` 對應常數經 tailwind-merge 之後的結果），合併 class 用不做衝突處理的 `cx`，
// 要蓋掉的地方直接各寫一份（`PRIMARY_LG`、`DANGER_OUTLINE`…），不靠合併。

/** 串 class（不做 tailwind-merge）：條件式 class 不能和前面的同性質工具類互相蓋，要蓋的用三元式二選一。 */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

const PRIMARY_SHAPE = 'btn-fju press shrink-0 whitespace-nowrap rounded-lg text-sm disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4'
/** `dashboard-kit` 的 `BTN_PRIMARY`。 */
export const PRIMARY = `${PRIMARY_SHAPE} h-9 px-4`
/** 表單底部的主要鈕（高一號）。 */
export const PRIMARY_LG = `${PRIMARY_SHAPE} h-10 px-5`
const OUTLINE_SHAPE =
  'group/button inline-flex shrink-0 items-center justify-center border bg-clip-padding text-sm whitespace-nowrap transition-all outline-none select-none ' +
  'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 ' +
  'aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 ' +
  "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 bg-background aria-expanded:bg-muted aria-expanded:text-foreground " +
  'dark:border-input dark:bg-input/30 dark:hover:bg-input/50 gap-1.5 pointer-coarse:min-h-11 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 ' +
  'press rounded-lg px-3 font-semibold'
/** `dashboard-kit` 的 `BTN_OUTLINE`（白底細框）。 */
export const SECONDARY = `${OUTLINE_SHAPE} h-9 border-border hover:bg-muted hover:text-foreground`
/** 矮一號的白底細框（正文工具列的「插入連結」）。 */
export const SECONDARY_SM = `${OUTLINE_SHAPE} h-8 border-border hover:bg-muted hover:text-foreground`
/** 紅框的危險鈕（全頁的「刪除」）。 */
export const DANGER_OUTLINE = `${OUTLINE_SHAPE} h-9 border-destructive/50 text-destructive hover:bg-destructive-subtle hover:text-destructive-on-subtle`
const ICON_SHAPE = 'inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors disabled:opacity-30 [&_svg]:size-4'
/** `dashboard-kit` 的 `BTN_ICON`（上移、下移）。 */
export const ICON_BUTTON = `${ICON_SHAPE} hover:bg-muted hover:text-foreground`
/** 刪除用的圖示小鈕。 */
export const ICON_DANGER = `${ICON_SHAPE} hover:bg-destructive-subtle hover:text-destructive`
const INPUT_SHAPE =
  'w-full rounded-lg border border-input bg-background px-3 text-sm font-normal outline-none ' +
  'transition-[border-color,box-shadow] focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/25 disabled:opacity-60'
/** 輸入框與多行輸入共用（不定高度，多行的 rows 才有效）。 */
export const INPUT = `mt-1.5 min-h-10 py-2 ${INPUT_SHAPE}`
/** 正文工具列裡的矮輸入框（連結網址）。 */
export const INPUT_SM = `${INPUT_SHAPE} h-8 min-h-8 min-w-0 flex-1 py-1`
export const LABEL = 'block text-sm font-semibold'

/**
 * 公告、資源發布時的「重要」勾選（Roy 2026-09-25 定）：勾了才逐人發站內通知給對象，一般公告只留發布紀錄。
 * 公開與所有登入者的對象＝全站有效帳號，預設不勾；其他對象（本屆學生、指定組別、全部老師）維持預設勾。
 */
export const IMPORTANT_LABEL = '重要公告：逐人發站內通知給對象'
/** 原生 `<dialog>` 的外觀（`dashboard-kit` 的 `DIALOG`，寬度另給）。 */
export const DIALOG_SHELL = 'm-auto rounded-xl border border-border bg-popover p-0 text-foreground shadow-xl backdrop:bg-black/40'
export const DIALOG = `${DIALOG_SHELL} w-[min(44rem,calc(100vw-2rem))]`

/** 「狀態」小標籤（`dashboard-kit` 的 `Pill`）。 */
export const STATUS_PILL = {
  default: 'inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-4xl border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap border-border bg-muted text-muted-foreground',
  success: 'inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-4xl border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap border-success/30 bg-success-subtle text-success-on-subtle',
} as const

/** 篩選 pill（`dashboard-kit` 的 `pillClass`）。 */
export function pillClass(active: boolean): string {
  return cx(
    'press inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-sm font-semibold transition-colors',
    active ? 'border-ink bg-ink text-ink-foreground' : 'border-border text-foreground hover:border-ink/40 hover:bg-accent',
  )
}

// 首頁也用到的三個圖示（`IconCheck`、`IconChevronRight`、`IconHistory`）在表單裡另建一份（同 tabler 的線條），理由見上。
export const CheckIcon = createReactComponent('outline', 'check', 'Check', [['path', { d: 'M5 12l5 5l10 -10', key: 'svg-0' }]])
export const ChevronIcon = createReactComponent('outline', 'chevron-right', 'ChevronRight', [['path', { d: 'M9 6l6 6l-6 6', key: 'svg-0' }]])
export const HistoryIcon = createReactComponent('outline', 'history', 'History', [
  ['path', { d: 'M12 8l0 4l2 2', key: 'svg-0' }],
  ['path', { d: 'M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5', key: 'svg-1' }],
])

// ── 上傳 ────────────────────────────────────────────────────────────────────

/** 先拿 ticket，再把位元組直接 POST 到 `/api/files/upload`（契約 02 §6；不經 Server Action）。 */
export async function uploadItemFile(
  file: File,
  cohortId: string,
  placement: string,
  kind: 'attachment' | 'cover',
): Promise<{ ok: true; chip: FileChip } | { ok: false; message: string }> {
  try {
    const ticket = await itemFormDeps().startItemUploadAction({
      cohortId,
      placement,
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
  placement,
  cover,
  onChange,
  accept,
  maxMiB,
  disabled,
}: {
  cohortId: string
  /** 項目目前的位置：屆別封存後只有榮譽能上傳，伺服器照這個判斷。 */
  placement: string
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
        className={cx(
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
            const result = await uploadItemFile(file, cohortId, placement, 'cover')
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
  return <div className={cx('prose-item space-y-2 leading-relaxed', className)} dangerouslySetInnerHTML={{ __html: html }} />
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
      className={cx(
        'rounded-lg px-3 py-2 text-sm font-semibold',
        tone === 'ok' ? 'bg-success-subtle text-success-on-subtle' : 'bg-destructive-subtle text-destructive-on-subtle',
      )}
    >
      {children}
    </p>
  )
}
