'use client'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { requestPosterUploadAction, saveEntryAction, withdrawAction } from './actions'
import {
  defaultShowcaseDraft,
  HOME_POSITION_MAX,
  type SaveEntryInput,
  type ShowcaseDraftFields,
  type ShowcaseEntryView,
} from '@/app/dashboard/admin/showcase/showcase-view'

/**
 * 成果展示的編輯視窗（C 階段規格① §4.5、§11.3 `ShowcaseEditDialog`；C1-09）：題目、摘要、影片連結、海報、獎項、首頁順序、
 * 公開／下架，按一次「儲存」存齊（`saveEntryAction` 依序呼叫既有用例）。取代原本每件展開的四顆存檔與危險操作區。
 *
 * - 三種開法：`edit`（清單列的「編輯」）、`create`（「新增 › 作品」選本屆某組）、`backfill`（「新增 › 補登歷屆作品」）。
 * - 海報：先要上傳憑證、把位元組直接 POST 到 `/api/files/upload`，選好只是「選好了」，按「儲存」才換上去；
 *   新作品要先建好才有地方掛海報，所以只有 `edit` 能上傳。
 * - 發布、發布更新要勾「已取得這組同學同意公開」（Q31，勾的人由伺服器記）；下架是一顆鈕＋一句確認，立刻生效。
 * - 刪除不在這裡：清單列的「刪除」（公開中停用並寫原因）。
 * - 成功由呼叫端關窗並提示一句；失敗留在視窗、打到一半的內容還在。
 */

const NOTE = 'mt-1 text-xs text-muted-foreground'
const ALERT = 'rounded-lg bg-destructive-subtle px-3 py-2 text-sm font-semibold text-destructive-on-subtle'
const CLOSE_BUTTON =
  'press inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground pointer-coarse:size-11 [&_svg]:size-5'

type Poster = { fileId: string; name: string; previewUrl?: string } | null

type ShowcaseEditActions = {
  requestPosterUploadAction: typeof requestPosterUploadAction
  saveEntryAction: typeof saveEntryAction
  withdrawAction: typeof withdrawAction
}

async function uploadPoster(
  entryId: string,
  file: File,
  requestPosterUpload: ShowcaseEditActions['requestPosterUploadAction'],
): Promise<{ ok: true; poster: NonNullable<Poster> } | { ok: false; message: string }> {
  try {
    const ticket = await requestPosterUpload({ entryId, fileName: file.name, declaredMime: file.type, declaredSize: file.size })
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

export type ShowcaseDialogTarget =
  | { mode: 'edit'; entry: ShowcaseEntryView }
  | { mode: 'create'; cohortLabel: string; groups: readonly { readonly id: string; readonly code: string }[] }
  | { mode: 'backfill'; cohorts: readonly { readonly id: string; readonly label: string }[] }

export function ShowcaseEditDialog({
  target,
  videoUrlMessage,
  awardLabelMax,
  actions: { requestPosterUploadAction, saveEntryAction, withdrawAction },
  styles: { DIALOG, INPUT, LABEL, PRIMARY, SECONDARY },
  onCancel,
  onSaved,
}: {
  target: ShowcaseDialogTarget
  /** 影片連結格式不對時瀏覽器顯示的提示（和伺服器驗證同一句，驗收 P-05）。 */
  videoUrlMessage: string
  awardLabelMax: number
  actions: ShowcaseEditActions
  styles: Record<'DIALOG' | 'INPUT' | 'LABEL' | 'PRIMARY' | 'SECONDARY', string>
  onCancel: () => void
  onSaved: (message: string) => void
}) {
  const entry = target.mode === 'edit' ? target.entry : null
  const initial: ShowcaseDraftFields = entry ?? defaultShowcaseDraft()
  const status = entry?.status ?? 'draft'
  const groupLabel = entry?.groupLabel ?? null
  const title =
    target.mode === 'edit'
      ? `編輯 ${target.entry.groupLabel}・${target.entry.cohortLabel}`
      : target.mode === 'create'
        ? `新增作品・${target.cohortLabel}`
        : '補登歷屆作品'

  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
  }, [])

  const [fields, setFields] = useState({
    title: initial.title,
    summary: initial.summary,
    videoUrl: initial.videoUrl,
    award: initial.award ?? '',
    awardLabel: initial.awardLabel,
    homePosition: initial.homePosition === null ? '' : String(initial.homePosition),
  })
  const set = (patch: Partial<typeof fields>) => setFields((f) => ({ ...f, ...patch }))
  const [groupId, setGroupId] = useState(target.mode === 'create' ? (target.groups[0]?.id ?? '') : '')
  const [cohortId, setCohortId] = useState(target.mode === 'backfill' ? (target.cohorts[0]?.id ?? '') : '')
  const [poster, setPoster] = useState<Poster>(initial.poster)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [lifecycle, setLifecycle] = useState(false)
  const [confirmWithdraw, setConfirmWithdraw] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<{ message: string; field?: string } | null>(null)
  const [requestIds] = useState(() => ({
    create: crypto.randomUUID(),
    draft: crypto.randomUUID(),
    award: crypto.randomUUID(),
    home: crypto.randomUUID(),
    lifecycle: crypto.randomUUID(),
    withdraw: crypto.randomUUID(),
  }))

  const draftLocked = entry ? (entry.locked ?? (entry.hasDraft ? null : '這件作品只有發布的版本，沒有可以改的草稿。')) : null
  const draftChanged =
    fields.title !== initial.title ||
    fields.summary !== initial.summary ||
    fields.videoUrl !== initial.videoUrl ||
    (poster?.fileId ?? null) !== (initial.poster?.fileId ?? null)
  const awardChanged = fields.award !== (initial.award ?? '') || (fields.award !== '' && fields.awardLabel !== initial.awardLabel)
  const homeChanged = fields.homePosition !== (initial.homePosition === null ? '' : String(initial.homePosition))
  const posterChanged = (poster?.fileId ?? null) !== (initial.poster?.fileId ?? null)
  const videoError = error?.field === 'videoUrl' ? error.message : null
  const titleMissing = fields.title.trim() === ''

  // 存完順便做的公開動作：草稿 → 發布；公開中 → 發布更新；已下架 → 重新發布（用下架前那一版）。
  const lifecycleKind = status === 'draft' ? 'publish' : status === 'published' ? 'publish_update' : 'republish'
  const lifecycleBlocked =
    lifecycleKind === 'republish'
      ? null
      : titleMissing
        ? '題目還是空白，先填好題目。'
        : lifecycleKind === 'publish_update' && !draftChanged && !entry?.hasUnpublishedChanges
          ? '草稿和前台目前那一版一樣；先改上面的內容，才有更新可以發布。'
          : null

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    if (target.mode === 'backfill' && titleMissing) {
      setError({ message: '補登歷屆作品要先填題目。' })
      return
    }
    const input: SaveEntryInput = {
      mode: target.mode,
      entryId: entry?.entryId ?? null,
      groupId: target.mode === 'create' ? groupId : null,
      cohortId: target.mode === 'backfill' ? cohortId : null,
      entryRevision: entry?.entryRevision ?? 1,
      draftRevision: entry?.draftRevision ?? 1,
      draft:
        target.mode !== 'edit' || (draftChanged && !draftLocked)
          ? { title: fields.title, summary: fields.summary, videoUrl: fields.videoUrl, posterFileId: poster?.fileId ?? null }
          : null,
      award: awardChanged ? { level: fields.award, label: fields.award === '' ? '' : fields.awardLabel } : null,
      home: homeChanged ? { position: fields.homePosition } : null,
      lifecycle: lifecycle && lifecycleBlocked === null ? lifecycleKind : null,
      consent: lifecycle,
      requestIds,
    }
    setPending(true)
    try {
      const result = await saveEntryAction(input)
      if (result.ok) onSaved(result.message)
      else setError({ message: result.message, field: result.field })
    } catch {
      setError({ message: '連線中斷；結果尚未確認，請重新整理頁面看看存了沒有。' })
    } finally {
      setPending(false)
    }
  }

  async function withdraw() {
    if (!entry) return
    setError(null)
    setPending(true)
    try {
      const form = new FormData()
      form.set('entryId', entry.entryId)
      form.set('revision', String(entry.entryRevision))
      form.set('requestId', requestIds.withdraw)
      const result = await withdrawAction(undefined, form)
      if (result?.ok) onSaved(result.message)
      else setError({ message: result?.message ?? '下架失敗，請重新整理頁面再試。' })
    } catch {
      setError({ message: '連線中斷；結果尚未確認，請重新整理頁面看狀態。' })
    } finally {
      setPending(false)
    }
  }

  const videoHintId = 'showcase-video-hint'
  const videoErrorId = 'showcase-video-error'

  return (
    <dialog
      ref={dialog}
      aria-label={title}
      data-testid="showcase-edit-dialog"
      className={DIALOG}
      onCancel={(e) => {
        e.preventDefault()
        onCancel()
      }}
    >
      <form onSubmit={submit} className="flex max-h-[90vh] flex-col" aria-label={groupLabel ? `${groupLabel} 的成果展示` : title}>
        <div className="flex items-center justify-between gap-3 border-b border-border px-6 py-4">
          <div className="min-w-0">
            <h2 className="text-lg font-extrabold">{title}</h2>
            {entry ? <p className="text-xs text-muted-foreground">{entry.savedNote}</p> : null}
          </div>
          <button type="button" className={CLOSE_BUTTON} onClick={onCancel} aria-label="關閉">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          {target.mode === 'create' ? (
            target.groups.length === 0 ? (
              <p className="text-sm text-muted-foreground">這一屆每一組都已經有成果展示草稿了，直接在清單裡按「編輯」。</p>
            ) : (
              <label className={LABEL}>
                組別
                <select value={groupId} onChange={(e) => setGroupId(e.target.value)} className={INPUT} required>
                  {target.groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.code}
                    </option>
                  ))}
                </select>
              </label>
            )
          ) : null}
          {target.mode === 'backfill' ? (
            <div>
              <label className={LABEL}>
                屆別
                <select value={cohortId} onChange={(e) => setCohortId(e.target.value)} className={INPUT} required>
                  {target.cohorts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
              <p className={NOTE}>不用選組別；組別欄會顯示「（歷屆補登）」。</p>
            </div>
          ) : null}

          {entry && entry.status !== 'draft' && entry.hasUnpublishedChanges ? (
            <p className="text-xs text-muted-foreground" data-testid="unpublished-changes">
              前台目前顯示的是發布時那一版（題目「{entry.publishedTitle}」）；這裡草稿的修改要勾「發布更新」才會換上前台。
            </p>
          ) : null}
          {draftLocked ? <p className="text-xs text-muted-foreground">{draftLocked}</p> : null}

          <label className={LABEL}>
            {target.mode === 'backfill' ? '作品題目' : '題目'}
            <input
              value={fields.title}
              onChange={(e) => set({ title: e.target.value })}
              className={INPUT}
              maxLength={200}
              disabled={draftLocked !== null}
              placeholder={target.mode === 'backfill' ? '例如：智慧校園導覽系統' : undefined}
            />
          </label>
          <label className={LABEL}>
            摘要
            <textarea
              rows={4}
              value={fields.summary}
              onChange={(e) => set({ summary: e.target.value })}
              className={INPUT}
              maxLength={2000}
              disabled={draftLocked !== null}
            />
          </label>
          <div>
            <label className={LABEL}>
              影片連結
              <input
                type="url"
                value={fields.videoUrl}
                onChange={(e) => set({ videoUrl: e.target.value })}
                className={INPUT}
                placeholder="https://"
                disabled={draftLocked !== null}
                aria-invalid={videoError ? true : undefined}
                aria-describedby={videoError ? `${videoErrorId} ${videoHintId}` : videoHintId}
                // 瀏覽器內建檢查只會說「請輸入網址。」：換成說得出怎麼改的同一句（驗收 P-05）。
                onInvalid={(e) => e.currentTarget.setCustomValidity(videoUrlMessage)}
                onInput={(e) => e.currentTarget.setCustomValidity('')}
              />
            </label>
            <p id={videoHintId} className={NOTE}>
              只收 YouTube 影片網址（watch、youtu.be、shorts 都可以），不公開（unlisted）影片也可以。
            </p>
            {videoError ? (
              <p role="alert" id={videoErrorId} className="mt-1 text-sm text-danger">
                {videoError}
              </p>
            ) : null}
          </div>
          <div>
            <span className={LABEL}>海報（PNG 或 JPG）</span>
            {entry ? (
              <div className="mt-1 flex flex-wrap items-center gap-3">
                {poster ? (
                  <>
                    {/* 已存的海報預覽走 /api/files（每次都重新授權）；剛選的用本地預覽。 */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={poster.previewUrl ?? `/api/files/${poster.fileId}`} alt={`${entry.groupLabel} 海報`} className="h-24 w-auto rounded-md border border-border object-contain" />
                    <span className="text-sm text-ink" data-testid="poster-name">
                      {poster.name}
                      {posterChanged ? <span className="ml-1 text-xs text-muted-foreground">（儲存後才會換上）</span> : null}
                    </span>
                    <button type="button" className={SECONDARY} onClick={() => setPoster(null)} disabled={draftLocked !== null || pending}>
                      拿掉海報
                    </button>
                  </>
                ) : (
                  <span className="text-sm text-muted-foreground">還沒有海報</span>
                )}
                <label className={SECONDARY}>
                  {uploading ? '上傳中…' : poster ? '換一張' : '上傳海報'}
                  <input
                    type="file"
                    accept=".png,.jpg,.jpeg,image/png,image/jpeg"
                    className="sr-only"
                    aria-label="選擇海報圖檔"
                    disabled={draftLocked !== null || uploading}
                    onChange={async (e) => {
                      const file = e.target.files?.[0]
                      e.target.value = ''
                      if (!file) return
                      setUploading(true)
                      setUploadError(null)
                      const result = await uploadPoster(entry.entryId, file, requestPosterUploadAction)
                      setUploading(false)
                      if (result.ok) setPoster(result.poster)
                      else setUploadError(result.message)
                    }}
                  />
                </label>
              </div>
            ) : (
              <p className={NOTE}>存好之後在清單按「編輯」上傳海報。</p>
            )}
            {uploadError ? (
              <p role="alert" className="mt-1 text-sm text-danger">
                {uploadError}
              </p>
            ) : null}
          </div>

          <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
            <label className={LABEL}>
              獎項等級
              <select
                value={fields.award}
                onChange={(e) => set({ award: e.target.value as typeof fields.award, ...(e.target.value === '' ? { awardLabel: '' } : {}) })}
                className={INPUT}
              >
                <option value="">沒有獎項</option>
                <option value="excellent">優秀專題</option>
                <option value="merit">佳作</option>
              </select>
            </label>
            <label className={LABEL}>
              獎項名稱（選填，最多 {awardLabelMax} 字）
              <input
                value={fields.awardLabel}
                onChange={(e) => set({ awardLabel: e.target.value })}
                className={INPUT}
                maxLength={awardLabelMax}
                disabled={fields.award === ''}
                placeholder={fields.award === '' ? '先選獎項等級' : '例如：第 43 屆專題競賽第一名'}
              />
            </label>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">
            選了獎項、而且作品公開中，才會出現在
            <a href="/projects/featured" className="mx-1 underline underline-offset-2" target="_blank" rel="noopener noreferrer">
              「優秀專題」
            </a>
            與首頁輪播；沒有獎項的只在登入後的「歷屆專題一覽」。
          </p>

          <label className={LABEL}>
            首頁順序（1–{HOME_POSITION_MAX}，1 排最前；留空＝不排）
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={HOME_POSITION_MAX}
              step={1}
              value={fields.homePosition}
              onChange={(e) => set({ homePosition: e.target.value })}
              className={`${INPUT} block max-w-32`}
            />
          </label>

          <div role="group" aria-label="公開" className="space-y-2 rounded-lg border border-border p-3">
            <p className="text-sm font-semibold text-foreground">
              公開狀態：{status === 'draft' ? '草稿（不公開）' : status === 'published' ? '公開中' : '已下架'}
            </p>
            <div>
              <label className="flex items-start gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={lifecycle}
                  onChange={(e) => setLifecycle(e.target.checked)}
                  disabled={lifecycleBlocked !== null}
                  className="mt-0.5 size-4"
                  aria-describedby="showcase-lifecycle-hint"
                />
                {lifecycleKind === 'publish'
                  ? '儲存後發布：已取得這組同學同意公開'
                  : lifecycleKind === 'publish_update'
                    ? '儲存後發布更新：已取得這組同學同意公開'
                    : '儲存後重新發布'}
              </label>
              {/* 說明放在 label 外面：放裡面會變成勾選框名稱的一部分。 */}
              <p id="showcase-lifecycle-hint" className="mt-1 pl-6 text-xs text-muted-foreground">
                {lifecycleBlocked ??
                  (lifecycleKind === 'publish'
                    ? '系統會記下是你勾的。發布後登入的師生在「歷屆專題一覽」看得到；有選獎項的訪客也看得到。'
                    : lifecycleKind === 'publish_update'
                      ? '把草稿目前的內容換上前台；之前的版本保留在紀錄裡。系統會記下是你勾的。'
                      : '用下架前的那一版重新公開，不會換成目前的草稿內容。')}
              </p>
            </div>
            {status === 'published' && entry ? (
              confirmWithdraw ? (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span>下架後前台看不到、海報也不再公開；後台保留，之後可以重新發布。確定下架？</span>
                  <button type="button" className={SECONDARY} onClick={() => setConfirmWithdraw(false)} disabled={pending}>
                    先不要
                  </button>
                  <button type="button" className={PRIMARY} onClick={withdraw} disabled={pending}>
                    {pending ? '處理中…' : '確認下架'}
                  </button>
                </div>
              ) : (
                <button type="button" className={SECONDARY} onClick={() => setConfirmWithdraw(true)} disabled={pending}>
                  下架
                </button>
              )
            ) : null}
          </div>

          {error && !videoError ? (
            <p role="alert" className={ALERT}>
              {error.message}
            </p>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
          <button type="button" className={SECONDARY} onClick={onCancel} disabled={pending}>
            取消
          </button>
          <button
            type="submit"
            className={PRIMARY}
            disabled={pending || uploading || (target.mode === 'create' && target.groups.length === 0)}
          >
            {pending ? '儲存中…' : '儲存'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
