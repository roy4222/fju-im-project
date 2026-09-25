'use client'
import { useActionState, useState } from 'react'
import { createDraftAction, requestPosterUploadAction, updateDraftAction } from './actions'
import { Feedback, INPUT, LABEL, PRIMARY, SECONDARY } from '@/app/dashboard/admin/groups/admin-group-forms'

/**
 * 管理員「精選」頁會動的部分（票 25／S11-03）：替一組建立精選草稿、編輯草稿（題目、摘要、影片連結、海報）。
 *
 * 海報：先向伺服器要一張上傳憑證（只收 PNG／JPG），再把位元組直接 POST 到 `/api/files/upload`；
 * 上傳完只是「選好了」，按「儲存草稿」才真的換上去（伺服器綁新檔、放掉舊檔）。存草稿時帶著畫面看到的草稿版本，
 * 別人先存過就被拒、請重新載入。草稿不公開、沒有發布按鈕（發布在 S12）。
 */

export type ShowcaseActionState = { ok: boolean; message: string } | undefined

export function CreateDraftForm({
  groups,
  requestId,
}: {
  groups: readonly { readonly id: string; readonly code: string }[]
  requestId: string
}) {
  const [state, action, pending] = useActionState(createDraftAction, undefined)
  return (
    <form action={action} className="flex flex-wrap items-end gap-3" aria-label="建立精選草稿">
      <input type="hidden" name="requestId" value={requestId} />
      {groups.length === 0 ? (
        // 建完最後一組後表單留著（回執才不會跟著消失），只是沒有可以選的組。
        <p className="text-sm text-muted-foreground">這一屆每一組都已經有精選草稿了，直接在下面編輯。</p>
      ) : (
        <>
          <label className={LABEL}>
            組別
            <select name="groupId" className={INPUT} required defaultValue={groups[0]?.id}>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.code}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={PRIMARY} disabled={pending}>
            {pending ? '建立中…' : '建立草稿'}
          </button>
        </>
      )}
      <div className="w-full">
        <Feedback state={state} />
      </div>
    </form>
  )
}

/** `previewUrl`：剛選、還沒存的圖用瀏覽器本地的 blob 預覽（還沒綁到草稿前，下載政策不會放行）。 */
type Poster = { fileId: string; name: string; previewUrl?: string } | null

async function uploadPoster(entryId: string, file: File): Promise<{ ok: true; poster: NonNullable<Poster> } | { ok: false; message: string }> {
  try {
    const ticket = await requestPosterUploadAction({ entryId, fileName: file.name, declaredMime: file.type, declaredSize: file.size })
    if (!ticket.ok) return ticket
    const response = await fetch(`/api/files/upload?ticket=${encodeURIComponent(ticket.ticket.ticket)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    })
    const uploaded = (await response.json().catch(() => null)) as
      | { ok: true; fileId: string; originalName: string }
      | { ok: false; message: string }
      | null
    if (!uploaded || !uploaded.ok) return { ok: false, message: uploaded?.message ?? '上傳失敗，請重新選擇圖片。' }
    return { ok: true, poster: { fileId: uploaded.fileId, name: uploaded.originalName, previewUrl: URL.createObjectURL(file) } }
  } catch {
    return { ok: false, message: '連線中斷，請重新選擇圖片。' }
  }
}

export function DraftEditor({
  entryId,
  groupCode,
  revision,
  title,
  summary,
  videoUrl,
  poster,
  requestId,
  disabled,
}: {
  entryId: string
  groupCode: string
  revision: number
  title: string
  summary: string
  videoUrl: string | null
  poster: Poster
  requestId: string
  disabled?: boolean
}) {
  const [state, action, pending] = useActionState(updateDraftAction, undefined)
  // 受控：送出被拒（例如別人先存過）時，打到一半的內容還在。
  const [fields, setFields] = useState({ title, summary, videoUrl: videoUrl ?? '' })
  const [chosen, setChosen] = useState<Poster>(poster)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const posterChanged = (chosen?.fileId ?? null) !== (poster?.fileId ?? null)

  return (
    <form action={action} className="space-y-3" aria-label={`${groupCode} 的精選草稿`}>
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="entryId" value={entryId} />
      <input type="hidden" name="revision" value={revision} />
      <input type="hidden" name="posterFileId" value={chosen?.fileId ?? ''} />
      <label className={LABEL}>
        題目
        <input
          name="title"
          value={fields.title}
          onChange={(e) => setFields({ ...fields, title: e.target.value })}
          className={INPUT}
          maxLength={200}
          disabled={disabled}
        />
      </label>
      <label className={LABEL}>
        摘要
        <textarea
          name="summary"
          rows={4}
          value={fields.summary}
          onChange={(e) => setFields({ ...fields, summary: e.target.value })}
          className={INPUT}
          maxLength={2000}
          disabled={disabled}
        />
      </label>
      <label className={LABEL}>
        影片連結
        <input
          name="videoUrl"
          type="url"
          value={fields.videoUrl}
          onChange={(e) => setFields({ ...fields, videoUrl: e.target.value })}
          className={INPUT}
          placeholder="https://"
          disabled={disabled}
        />
      </label>
      <div>
        <span className={LABEL}>海報（PNG 或 JPG）</span>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          {chosen ? (
            <>
              {/* 已存的海報預覽走 /api/files（每次都重新授權）；剛選的用本地預覽。 */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={chosen.previewUrl ?? `/api/files/${chosen.fileId}`} alt={`${groupCode} 海報`} className="h-24 w-auto rounded-md border border-border object-contain" />
              <span className="text-sm text-ink" data-testid="poster-name">
                {chosen.name}
                {posterChanged ? <span className="ml-1 text-xs text-muted-foreground">（儲存後才會換上）</span> : null}
              </span>
              <button type="button" className={SECONDARY} onClick={() => setChosen(null)} disabled={disabled || pending}>
                拿掉海報
              </button>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">還沒有海報</span>
          )}
          <label className={SECONDARY}>
            {uploading ? '上傳中…' : chosen ? '換一張' : '上傳海報'}
            <input
              type="file"
              accept=".png,.jpg,.jpeg,image/png,image/jpeg"
              className="sr-only"
              aria-label="選擇海報圖檔"
              disabled={disabled || uploading}
              onChange={async (e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (!file) return
                setUploading(true)
                setUploadError(null)
                const result = await uploadPoster(entryId, file)
                setUploading(false)
                if (result.ok) setChosen(result.poster)
                else setUploadError(result.message)
              }}
            />
          </label>
        </div>
        {uploadError ? (
          <p role="alert" className="mt-1 text-sm text-danger">
            {uploadError}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={PRIMARY} disabled={disabled || pending || uploading}>
          {pending ? '儲存中…' : '儲存草稿'}
        </button>
        <span className="text-xs text-muted-foreground">草稿第 {revision} 版・只存不發布</span>
      </div>
      <Feedback state={state} />
    </form>
  )
}
