'use client'
import { useActionState, useEffect, useState } from 'react'
import { requestHeroUploadAction, resetHomeSettingsAction, saveHomeSettingsAction } from './actions'
import { DIALOG_DESC, DIALOG_TITLE } from '@/app/_ui/dashboard/look'
import { DIALOG, Feedback, INPUT, LABEL, PRIMARY, SECONDARY, useDialog } from '@/app/dashboard/admin/groups/admin-group-forms'

/**
 * 首頁設定會動的部分（第三波 W3）：大圖（上傳＋即時預覽）、圖片說明、標語兩行，下面是「首頁大圖預覽」。
 *
 * 大圖：先向伺服器要一張上傳憑證（只收 PNG／JPG），再把位元組直接 POST 到 `/api/files/upload`；
 * 上傳完只是「選好了」（用瀏覽器本地預覽），按「儲存並更新首頁」才真的換上去、訪客才看得到。
 * 存檔帶著畫面看到的設定版本，另一個分頁先存過就被擋、請重新整理。欄位空白＝用預設。
 */

export type HomeSettingsActionState = { ok: boolean; message: string; reset?: boolean } | undefined

type Hero = { fileId: string; name: string; previewUrl: string } | null

type Defaults = { heroSrc: string; line1: string; line2: string }
type Limits = { line1: number; line2: number; heroAlt: number }

async function uploadHero(file: File): Promise<{ ok: true; hero: NonNullable<Hero> } | { ok: false; message: string }> {
  try {
    const ticket = await requestHeroUploadAction({ fileName: file.name, declaredMime: file.type, declaredSize: file.size })
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
    return { ok: true, hero: { fileId: uploaded.fileId, name: uploaded.originalName, previewUrl: URL.createObjectURL(file) } }
  } catch {
    return { ok: false, message: '連線中斷，請重新選擇圖片。' }
  }
}

/** 以字計（同伺服器與資料庫的 `char_length`）。 */
const count = (value: string) => Array.from(value.trim()).length

export function HomeSettingsForm({
  revision,
  requestId,
  resetRequestId,
  saved,
  defaults,
  limits,
  maxImageLabel,
}: {
  /** 還沒存過是 0。 */
  revision: number
  requestId: string
  resetRequestId: string
  saved: { heroFileId: string | null; heroAlt: string; line1: string; line2: string }
  defaults: Defaults
  limits: Limits
  maxImageLabel: string
}) {
  const [state, action, pending] = useActionState(saveHomeSettingsAction, undefined)
  const [resetState, resetAction, resetting] = useActionState(resetHomeSettingsAction, undefined)
  // 受控：送出被拒（例如另一個分頁先存過）時，打到一半的內容還在。
  const [fields, setFields] = useState({ heroAlt: saved.heroAlt, line1: saved.line1, line2: saved.line2 })
  const [hero, setHero] = useState<Hero>(
    saved.heroFileId ? { fileId: saved.heroFileId, name: '目前的首頁大圖', previewUrl: `/api/files/${saved.heroFileId}` } : null,
  )
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const confirm = useDialog()

  // 恢復預設成功：表單也回到「全部空白＝用預設」。
  useEffect(() => {
    if (!resetState?.reset) return
    setFields({ heroAlt: '', line1: '', line2: '' })
    setHero(null)
    confirm.close()
  }, [resetState, confirm.close])

  const heroChanged = (hero?.fileId ?? null) !== saved.heroFileId
  const preview = {
    src: hero?.previewUrl ?? defaults.heroSrc,
    alt: hero ? fields.heroAlt.trim() : '',
    line1: fields.line1.trim() || defaults.line1,
    line2: fields.line2.trim() || defaults.line2,
  }
  const busy = pending || uploading || resetting

  return (
    <div className="space-y-6">
      <form action={action} className="max-w-2xl space-y-5" aria-label="首頁設定">
        <input type="hidden" name="requestId" value={requestId} />
        <input type="hidden" name="revision" value={revision} />
        <input type="hidden" name="heroFileId" value={hero?.fileId ?? ''} />

        <fieldset className="space-y-3">
          <legend className={LABEL}>首頁大圖（PNG 或 JPG，{maxImageLabel} 以內）</legend>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-ink" data-testid="hero-name">
              {hero ? hero.name : '使用預設的校園照片'}
              {heroChanged ? <span className="ml-1 text-xs text-muted-foreground">（儲存後才會換上）</span> : null}
            </span>
            <label className={SECONDARY}>
              {uploading ? '上傳中…' : hero ? '換一張' : '上傳圖片'}
              <input
                type="file"
                accept=".png,.jpg,.jpeg,image/png,image/jpeg"
                className="sr-only"
                aria-label="選擇首頁大圖"
                disabled={busy}
                onChange={async (e) => {
                  const file = e.target.files?.[0]
                  e.target.value = ''
                  if (!file) return
                  setUploading(true)
                  setUploadError(null)
                  const result = await uploadHero(file)
                  setUploading(false)
                  if (result.ok) setHero(result.hero)
                  else setUploadError(result.message)
                }}
              />
            </label>
            {hero ? (
              <button type="button" className={SECONDARY} onClick={() => setHero(null)} disabled={busy}>
                改用預設照片
              </button>
            ) : null}
          </div>
          {uploadError ? (
            <p role="alert" className="text-sm text-danger">
              {uploadError}
            </p>
          ) : null}
          <label className={LABEL}>
            圖片說明{hero ? '（必填）' : ''}
            <input
              name="heroAlt"
              value={fields.heroAlt}
              onChange={(e) => setFields({ ...fields, heroAlt: e.target.value })}
              className={INPUT}
              disabled={!hero || busy}
              placeholder={hero ? '例如：利瑪竇大樓外觀' : '上傳自訂圖片後再填'}
              aria-describedby="hero-alt-hint"
            />
          </label>
          <p id="hero-alt-hint" className="text-xs text-muted-foreground">
            看不到圖片的人（例如用螢幕報讀）會聽到這段文字。{count(fields.heroAlt)}／{limits.heroAlt} 字
          </p>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className={LABEL}>標語（空白＝用預設的字）</legend>
          <label className={LABEL}>
            標語第一行（首頁大標題）
            <input
              name="line1"
              value={fields.line1}
              onChange={(e) => setFields({ ...fields, line1: e.target.value })}
              className={INPUT}
              placeholder={defaults.line1}
              disabled={busy}
              aria-describedby="line1-hint"
            />
          </label>
          <p id="line1-hint" className="text-xs text-muted-foreground">
            {count(fields.line1)}／{limits.line1} 字
          </p>
          <label className={LABEL}>
            標語第二行（大標題下面的說明）
            <input
              name="line2"
              value={fields.line2}
              onChange={(e) => setFields({ ...fields, line2: e.target.value })}
              className={INPUT}
              placeholder={defaults.line2}
              disabled={busy}
              aria-describedby="line2-hint"
            />
          </label>
          <p id="line2-hint" className="text-xs text-muted-foreground">
            {count(fields.line2)}／{limits.line2} 字
          </p>
        </fieldset>

        <section aria-label="首頁大圖預覽" className="space-y-2">
          <h2 className="text-sm font-semibold text-foreground">首頁大圖預覽</h2>
          {/* 同前台 hero 的縮小版，用表單當下的值；剛選的圖用瀏覽器本地預覽。 */}
          <div className="relative overflow-hidden rounded-xl bg-ink text-ink-foreground" data-testid="home-preview">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={preview.src} alt={preview.alt} className="absolute inset-0 h-full w-full object-cover opacity-55" />
            <div className="absolute inset-0 bg-gradient-to-r from-ink/95 via-ink/55 to-ink/15" aria-hidden />
            <div className="relative flex min-h-56 flex-col justify-center gap-3 px-6 py-8">
              <span className="inline-flex items-center gap-2 text-xs font-bold tracking-widest opacity-90">
                <span className="inline-block h-0.5 w-5 bg-primary" aria-hidden />
                資訊管理學系專題
              </span>
              <p className="max-w-md text-2xl leading-tight font-extrabold text-white" data-testid="preview-line1">
                {preview.line1}
              </p>
              <p className="max-w-sm text-sm leading-relaxed opacity-90" data-testid="preview-line2">
                {preview.line2}
              </p>
            </div>
          </div>
        </section>

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className={PRIMARY} disabled={busy}>
            {pending ? '儲存中…' : '儲存並更新首頁'}
          </button>
          <span className="text-xs text-muted-foreground">存了就生效，不需要另外發布。</span>
        </div>
        <Feedback state={state} />
      </form>

      {/* 恢復預設會丟掉目前的自訂內容，跟日常的儲存拉開，並先確認一次（全站 UX 規則 1）。 */}
      <section aria-label="恢復預設" className="max-w-2xl space-y-2 border-t border-border pt-5">
        <h2 className="text-sm font-semibold text-foreground">恢復預設</h2>
        <p className="text-sm text-muted-foreground">首頁大圖與兩行標語回到原本的校園照片與預設文字。</p>
        <button type="button" className={SECONDARY} onClick={confirm.open} disabled={busy}>
          恢復預設
        </button>
        <Feedback state={resetState?.ok ? resetState : undefined} />
        <dialog ref={confirm.ref} aria-label="恢復首頁預設？" className={DIALOG}>
          <form action={resetAction} className="space-y-4 p-5">
            <input type="hidden" name="requestId" value={resetRequestId} />
            <input type="hidden" name="revision" value={revision} />
            <h2 className={DIALOG_TITLE}>恢復首頁預設？</h2>
            <p className={DIALOG_DESC}>
              所有訪客重新整理首頁就會看到原本的校園照片與預設標語。目前的自訂圖片說明與標語不會保留，之後要用得重新上傳、重新填。
            </p>
            <Feedback state={resetState?.ok ? undefined : resetState} />
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" className={SECONDARY} onClick={confirm.close}>
                先不要
              </button>
              <button type="submit" disabled={resetting} className={PRIMARY}>
                {resetting ? '處理中…' : '恢復預設'}
              </button>
            </div>
          </form>
        </dialog>
      </section>
    </div>
  )
}
