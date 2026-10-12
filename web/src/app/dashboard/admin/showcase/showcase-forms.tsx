'use client'
import Link from 'next/link'
import { useActionState, useState } from 'react'
import {
  createBackfillAction,
  createDraftAction,
  deleteEntryAction,
  lifecycleAction,
  requestPosterUploadAction,
  setAwardAction,
  setHomePositionAction,
  updateDraftAction,
} from './actions'
import { buttonVariants } from '@/app/_ui/ui/button'
import { DIALOG, Feedback, INPUT, LABEL, PRIMARY, SECONDARY, useCloseOnSuccess, useDialog } from '@/app/dashboard/admin/groups/admin-group-forms'

const DANGER = buttonVariants({ variant: 'destructive', size: 'lg', className: 'press rounded-lg px-3 font-semibold disabled:opacity-60' })

/**
 * 管理員「精選」頁會動的部分（票 25／S11-03）：替一組建立精選草稿、編輯草稿（題目、摘要、影片連結、海報）。
 *
 * 海報：先向伺服器要一張上傳憑證（只收 PNG／JPG），再把位元組直接 POST 到 `/api/files/upload`；
 * 上傳完只是「選好了」，按「儲存草稿」才真的換上去（伺服器綁新檔、放掉舊檔）。存草稿時帶著畫面看到的草稿版本，
 * 別人先存過就被拒、請重新載入。草稿不公開。
 *
 * 第三波 W2：發布（勾「已取得這組同學同意公開」才按得下去）、下架、重新發布、獎項、刪除（危險操作區＋確認視窗，
 * 設計方案 §9 規則 1）。狀態規則在用例裡判；畫面只把不能按的鈕停用並寫原因。
 *
 * 第三波 W15：補登歷屆作品（選屆別＋題目，沒有組別）、首頁順序、公開中作品的「發布更新」（把改好的草稿換上前台）。
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
    <form action={action} className="flex flex-wrap items-end gap-3" aria-label="建立成果展示草稿">
      <input type="hidden" name="requestId" value={requestId} />
      {groups.length === 0 ? (
        // 建完最後一組後表單留著（回執才不會跟著消失），只是沒有可以選的組。
        <p className="text-sm text-muted-foreground">這一屆每一組都已經有成果展示草稿了，直接在下面編輯。</p>
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

/** 補登歷屆作品：選屆別（含已封存的）、填題目；建好後在下面那件作品補內容、勾同意發布。 */
export function BackfillForm({
  cohorts,
  requestId,
}: {
  cohorts: readonly { readonly id: string; readonly label: string }[]
  requestId: string
}) {
  const [state, action, pending] = useActionState(createBackfillAction, undefined)
  return (
    <form action={action} className="space-y-3" aria-label="補登歷屆作品">
      <input type="hidden" name="requestId" value={requestId} />
      <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
        <label className={LABEL}>
          屆別
          <select name="cohortId" className={INPUT} required defaultValue={cohorts[0]?.id}>
            {cohorts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className={LABEL}>
          作品題目
          <input name="title" className={INPUT} required maxLength={200} placeholder="例如：智慧校園導覽系統" />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={SECONDARY} disabled={pending}>
          {pending ? '補登中…' : '補登作品'}
        </button>
        <span className="text-xs text-muted-foreground">不用選組別；組別欄會顯示「（歷屆補登）」。</span>
      </div>
      <Feedback state={state} />
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
    <form action={action} className="space-y-3" aria-label={`${groupCode} 的成果展示草稿`}>
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
        <span className="text-xs text-muted-foreground">草稿第 {revision} 版・存草稿不會改到前台，發布後才公開</span>
      </div>
      <Feedback state={state} />
    </form>
  )
}

type EntryRef = { entryId: string; revision: number; requestId: string; label: string }

function EntryHidden({ entryId, revision, requestId }: Omit<EntryRef, 'label'>) {
  return (
    <>
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="entryId" value={entryId} />
      <input type="hidden" name="revision" value={revision} />
    </>
  )
}

/**
 * 發布狀態：草稿 → 勾同意＋發布；公開中 → 下架；已下架 → 重新發布。下架、重新發布可以來回，不加確認視窗
 * （§9 規則 1：只有不可逆或影響多人的才確認），只把後果寫在按鈕旁。
 */
export function PublishPanel({
  status,
  titleMissing,
  hasUnpublishedChanges,
  ...ref
}: EntryRef & { status: 'draft' | 'published' | 'withdrawn'; titleMissing: boolean; hasUnpublishedChanges: boolean }) {
  // 三個按鈕共用一個狀態：發布成功後這裡換成「下架」，剛剛那句回饋仍留在畫面上。
  const [consent, setConsent] = useState(false)
  // 同意只算這一次（Q31）：發布或發布更新成功後清掉勾選，下一次要重新勾（按鈕回到停用）。
  const [state, action, pending] = useActionState(async (previous: ShowcaseActionState, formData: FormData) => {
    const result = await lifecycleAction(previous, formData)
    if (result?.ok) setConsent(false)
    return result
  }, undefined)

  if (status === 'draft') {
    const reason = titleMissing ? '題目還是空白，先在上面填好題目並儲存草稿。' : consent ? null : '要先勾選上面的同意，才能發布。'
    return (
      <form action={action} className="space-y-2" aria-label={`發布 ${ref.label}`}>
        <EntryHidden {...ref} />
        <input type="hidden" name="intent" value="publish" />
        <label className="flex items-start gap-2 text-sm text-ink">
          <input type="checkbox" name="consent" value="yes" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 size-4" />
          <span>
            已取得這組同學同意公開
            <span className="block text-xs text-muted-foreground">系統會記下是你勾的。發布後登入的師生在「歷屆專題一覽」看得到；有選獎項的訪客也看得到。</span>
          </span>
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className={PRIMARY} disabled={reason !== null || pending}>
            {pending ? '發布中…' : '發布'}
          </button>
          {reason ? <span className="text-xs text-muted-foreground">{reason}</span> : null}
        </div>
        <Feedback state={state} />
      </form>
    )
  }
  if (status === 'published') {
    // 同一張表單兩顆鈕（`intent` 跟著按下的那顆送出）：發布更新、下架共用一個回饋。
    const updateReason = titleMissing
      ? '題目還是空白，先在上面填好題目並儲存草稿。'
      : !hasUnpublishedChanges
        ? '草稿和前台目前那一版一樣；先改上面的草稿並儲存，才有更新可以發布。'
        : consent
          ? null
          : '要先勾選上面的同意，才能發布更新。'
    return (
      <form action={action} className="space-y-3" aria-label={`公開中 ${ref.label}`}>
        <EntryHidden {...ref} />
        <div className="space-y-2">
          {hasUnpublishedChanges ? (
            <label className="flex items-start gap-2 text-sm text-ink">
              <input type="checkbox" name="consent" value="yes" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 size-4" />
              <span>
                已取得這組同學同意公開
                <span className="block text-xs text-muted-foreground">發布更新會把新內容公開；系統會記下是你勾的。</span>
              </span>
            </label>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" name="intent" value="publish_update" className={PRIMARY} disabled={updateReason !== null || pending}>
              {pending ? '處理中…' : '發布更新'}
            </button>
            <span className="text-xs text-muted-foreground">
              {updateReason ?? '把上面草稿目前的內容（題目、摘要、影片連結、海報）換上前台；之前的版本保留在紀錄裡。'}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" name="intent" value="withdraw" className={SECONDARY} disabled={pending}>
            {pending ? '處理中…' : '下架'}
          </button>
          <span className="text-xs text-muted-foreground">
            下架後前台看不到（作品網址顯示「這則作品已下架」），海報也不再公開；後台保留，之後可以重新發布。
          </span>
        </div>
        <Feedback state={state} />
      </form>
    )
  }
  return (
    <form action={action} className="space-y-2" aria-label={`重新發布 ${ref.label}`}>
      <EntryHidden {...ref} />
      <input type="hidden" name="intent" value="republish" />
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={PRIMARY} disabled={pending}>
          {pending ? '發布中…' : '重新發布'}
        </button>
        <span className="text-xs text-muted-foreground">用下架前的那一版重新公開，不會換成目前的草稿內容。</span>
      </div>
      <Feedback state={state} />
    </form>
  )
}

/** 獎項：選了等級才會上「優秀專題」與首頁輪播（§9 規則 2：相依設定就地說明＋入口）。 */
export function AwardForm({
  award,
  awardLabel,
  labelMax,
  ...ref
}: EntryRef & { award: 'excellent' | 'merit' | null; awardLabel: string | null; labelMax: number }) {
  const [state, action, pending] = useActionState(setAwardAction, undefined)
  const [level, setLevel] = useState<string>(award ?? '')
  const [label, setLabel] = useState(awardLabel ?? '')
  return (
    <form action={action} className="space-y-2" aria-label={`${ref.label} 的獎項`}>
      <EntryHidden {...ref} />
      <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
        <label className={LABEL}>
          獎項等級
          <select
            name="awardLevel"
            className={INPUT}
            value={level}
            onChange={(e) => {
              setLevel(e.target.value)
              if (e.target.value === '') setLabel('')
            }}
          >
            <option value="">沒有獎項</option>
            <option value="excellent">優秀專題</option>
            <option value="merit">佳作</option>
          </select>
        </label>
        <label className={LABEL}>
          獎項名稱（選填，最多 {labelMax} 字）
          <input
            name="awardLabel"
            className={INPUT}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={labelMax}
            disabled={level === ''}
            placeholder={level === '' ? '先選獎項等級' : '例如：第 43 屆專題競賽第一名'}
          />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        選了獎項、而且作品公開中，才會出現在
        <Link href="/projects/featured" className="mx-1 underline underline-offset-2" target="_blank">
          「優秀專題」
        </Link>
        與首頁輪播；沒有獎項的只在登入後的「歷屆專題一覽」。
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={SECONDARY} disabled={pending}>
          {pending ? '儲存中…' : '儲存獎項'}
        </button>
      </div>
      <Feedback state={state} />
    </form>
  )
}

/** 首頁順序：只決定首頁輪播裡的先後（§9 規則 2：寫清楚影響哪裡、什麼時候才會出現）。 */
export function HomePositionForm({
  homePosition,
  showsOnHome,
  max,
  ...ref
}: EntryRef & { homePosition: number | null; showsOnHome: boolean; max: number }) {
  const [state, action, pending] = useActionState(setHomePositionAction, undefined)
  return (
    <form action={action} className="space-y-2" aria-label={`${ref.label} 的首頁順序`}>
      <EntryHidden {...ref} />
      <label className={LABEL}>
        首頁順序（1–{max}，1 排最前；留空＝不排）
        <input
          name="homePosition"
          type="number"
          inputMode="numeric"
          min={1}
          max={max}
          step={1}
          defaultValue={homePosition ?? ''}
          className={`${INPUT} max-w-32`}
        />
      </label>
      <p className="text-xs text-muted-foreground">
        {showsOnHome ? '這件作品目前在' : '有獎項而且公開中的作品才會出現在'}
        <Link href="/" className="mx-1 underline underline-offset-2" target="_blank">
          首頁輪播
        </Link>
        ，依這個數字由小到大排；沒填的排在有填的後面。
      </p>
      <button type="submit" className={SECONDARY} disabled={pending}>
        {pending ? '儲存中…' : '儲存順序'}
      </button>
      <Feedback state={state} />
    </form>
  )
}

/** 危險操作：刪除（§9 規則 1：對象、範圍、後果、能不能恢復；確認鈕寫動作）。公開中時停用並寫原因。 */
export function DeleteEntry({ blockedReason, title, ...ref }: EntryRef & { blockedReason: string | null; title: string }) {
  const [state, action, pending] = useActionState(deleteEntryAction, undefined)
  const dialog = useDialog()
  useCloseOnSuccess(state, dialog.close)
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={DANGER}
          onClick={dialog.open}
          disabled={blockedReason !== null}
        >
          刪除這件作品
        </button>
        <span className="text-xs text-muted-foreground">{blockedReason ?? '刪除後看板與前台都不再出現，不能恢復。'}</span>
      </div>
      <Feedback state={state?.ok ? state : undefined} />
      <dialog ref={dialog.ref} aria-label="刪除作品" className={DIALOG}>
        <form action={action} className="space-y-4 p-5">
          <EntryHidden {...ref} />
          <div>
            <h2 className="text-lg font-extrabold text-foreground">刪除 {ref.label}</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              <li>對象：「{title || '（未填題目）'}」這一件作品，含草稿與已發布過的版本。</li>
              <li>後果：成果展示、優秀專題、歷屆專題一覽都不再出現；作品網址顯示找不到，海報也打不開（系辦也一樣）。</li>
              <li>操作紀錄會留一筆是誰刪的。</li>
              <li>
                <b className="text-foreground">不能恢復</b>；只是暫時不想公開，請改用「下架」。
              </li>
            </ul>
          </div>
          <Feedback state={state?.ok ? undefined : state} />
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <button type="button" className={SECONDARY} onClick={dialog.close}>
              先不要
            </button>
            <button type="submit" disabled={pending} className={DANGER}>
              {pending ? '刪除中…' : '刪除這件作品'}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  )
}
