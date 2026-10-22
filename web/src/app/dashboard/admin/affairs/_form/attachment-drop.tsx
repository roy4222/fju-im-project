'use client'
import { useState, type DragEvent } from 'react'
import { IconArrowDown, IconArrowUp, IconFileUpload, IconPaperclip, IconTrash } from '@tabler/icons-react'
import { cx, formatSize, ICON_BUTTON, ICON_DANGER, uploadItemFile, type FileChip } from '@/app/dashboard/admin/affairs/item-form-parts'

/**
 * 附件區（C 階段規格① §2.3）：拖檔案進虛線框（原生 `drop`）或點選，都走同一條上傳（ticket → `/api/files/upload`）。
 * 上限 20 個；單檔大小與型別照伺服器的附件規則（`ITEM_UPLOAD.attachment`，由 vocabulary 帶進來），伺服器再驗一次。
 * 已附上的可以上下移（前台照這個順序列）與移除；拖曳只用來加檔，不用來排序（排序用按鈕，鍵盤也能用）。
 */

const MIB = 1024 * 1024
/** 一筆最多幾個附件（既有上限）。 */
export const MAX_ATTACHMENTS = 20

export function AttachmentDrop({
  cohortId,
  placement,
  attachments,
  onChange,
  accept,
  maxMiB,
  disabled,
}: {
  cohortId: string
  /** 項目目前的位置：屆別封存後只有榮譽能上傳，伺服器照這個判斷。 */
  placement: string
  attachments: readonly FileChip[]
  onChange: (next: FileChip[]) => void
  accept: string
  maxMiB: number
  disabled?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [over, setOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const full = attachments.length >= MAX_ATTACHMENTS

  async function upload(files: readonly File[]) {
    if (files.length === 0) return
    setError(null)
    const room = MAX_ATTACHMENTS - attachments.length
    if (room <= 0) {
      setError(`附件最多 ${MAX_ATTACHMENTS} 個；要加新的請先移除一個。`)
      return
    }
    setBusy(true)
    const added: FileChip[] = []
    for (const file of files.slice(0, room)) {
      const result = await uploadItemFile(file, cohortId, placement, 'attachment')
      if (!result.ok) {
        setError(`${file.name}：${result.message}`)
        break
      }
      added.push(result.chip)
    }
    if (files.length > room) setError(`附件最多 ${MAX_ATTACHMENTS} 個，只加了前 ${room} 個。`)
    onChange([...attachments, ...added])
    setBusy(false)
  }

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta
    if (target < 0 || target >= attachments.length) return
    const next = [...attachments]
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    onChange(next)
  }

  const dropFiles = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault()
    setOver(false)
    if (busy || disabled) return
    void upload(Array.from(e.dataTransfer.files))
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
              <button type="button" className={ICON_BUTTON} onClick={() => move(index, -1)} disabled={disabled || index === 0} aria-label={`上移 ${a.name}`}>
                <IconArrowUp />
              </button>
              <button
                type="button"
                className={ICON_BUTTON}
                onClick={() => move(index, 1)}
                disabled={disabled || index === attachments.length - 1}
                aria-label={`下移 ${a.name}`}
              >
                <IconArrowDown />
              </button>
              <button
                type="button"
                className={ICON_DANGER}
                onClick={() => onChange(attachments.filter((x) => x.fileId !== a.fileId))}
                disabled={disabled}
                aria-label={`移除 ${a.name}`}
              >
                <IconTrash />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {/* 虛線框整塊可點，也可以把檔案拖進來。 */}
      <label
        data-testid="attachment-drop"
        onDragOver={(e) => {
          e.preventDefault()
          if (!over) setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={dropFiles}
        className={cx(
          'flex cursor-pointer items-center gap-3 rounded-xl border border-dashed px-4 py-3 text-left text-sm transition-colors hover:border-primary',
          over ? 'border-primary bg-primary-subtle/40' : 'border-border hover:bg-primary-subtle/30',
          (busy || disabled || full) && 'pointer-events-none opacity-50',
        )}
      >
        <IconFileUpload aria-hidden className="size-5 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          <span className="block font-semibold">{busy ? '上傳中…' : full ? `已有 ${MAX_ATTACHMENTS} 個附件（上限）` : '拖檔案到這裡，或點這裡選檔'}</span>
          <span className="block text-xs text-muted-foreground">
            可上傳 {accept.replaceAll(',', '、')}，單檔上限 {formatSize(maxMiB * MIB)}，最多 {MAX_ATTACHMENTS} 個。下載權限跟著這一筆的對象走。
          </span>
        </span>
        <input
          type="file"
          className="sr-only"
          multiple
          accept={accept}
          aria-label="加入附件"
          disabled={busy || disabled || full}
          onChange={(e) => {
            const files = Array.from(e.currentTarget.files ?? [])
            e.currentTarget.value = ''
            void upload(files)
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
