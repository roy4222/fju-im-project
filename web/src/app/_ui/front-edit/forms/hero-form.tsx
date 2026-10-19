'use client'
import { useState, useTransition, type FormEvent } from 'react'
import { requestHeroUploadAction, saveHeroAction } from './actions'
import type { FeFormProps } from '../forms'
import { BTN_SUBMIT, INPUT, LABEL } from '@/app/_ui/dashboard/look'

/**
 * 首頁橫幅的前台編輯表單（C2-17；原後台「首頁設定」搬到前台，用例不變：`HomeSettingsCommand.save`）。
 *
 * 大圖：先向伺服器要一張上傳憑證（只收 PNG／JPG），再把位元組直接 POST 到 `/api/files/upload`（契約 02 §6）；
 * 上傳完只是「選好了」，按「儲存」才真的換上去、訪客才看得到。欄位空白＝用預設；
 * 「改用預設照片」＋三欄清空再儲存就等於以前的「恢復預設」。存檔帶著畫面看到的版本，另一個分頁先存過就被擋。
 */

type Hero = { fileId: string; name: string } | null

const str = (value: unknown) => (typeof value === 'string' ? value : value == null ? '' : String(value))

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
    return { ok: true, hero: { fileId: uploaded.fileId, name: uploaded.originalName } }
  } catch {
    return { ok: false, message: '連線中斷，請重新選擇圖片。' }
  }
}

export default function HeroForm({ revision, fields, onDone, onCancel }: FeFormProps) {
  const savedFileId = str(fields.heroFileId)
  const [values, setValues] = useState({ heroAlt: str(fields.heroAlt), line1: str(fields.line1), line2: str(fields.line2) })
  const [hero, setHero] = useState<Hero>(savedFileId ? { fileId: savedFileId, name: '目前的首頁大圖' } : null)
  const [requestId] = useState(() => crypto.randomUUID())
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const busy = pending || uploading
  const heroChanged = (hero?.fileId ?? null) !== (savedFileId || null)

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError(null)
    startTransition(async () => {
      const result = await saveHeroAction({ revision: revision ?? 0, requestId, heroFileId: hero?.fileId ?? '', ...values })
      if (result.ok) onDone({ id: 'home', status: 'saved' })
      else setError(result.message)
    })
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" aria-label="編輯首頁橫幅" data-testid="fe-hero-form">
      {error ? (
        <p role="alert" className="fe-error">
          {error}
        </p>
      ) : null}
      <fieldset className="flex flex-col gap-2">
        <legend className={LABEL}>首頁大圖（PNG 或 JPG）</legend>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm" data-testid="hero-name">
            {hero ? hero.name : '使用預設的校園照片'}
            {heroChanged ? <span className="ml-1 text-xs text-muted-foreground">（儲存後才會換上）</span> : null}
          </span>
          <label className="fe-btn">
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
                setError(null)
                const result = await uploadHero(file)
                setUploading(false)
                if (result.ok) setHero(result.hero)
                else setError(result.message)
              }}
            />
          </label>
          {hero ? (
            <button type="button" className="fe-btn" onClick={() => setHero(null)} disabled={busy}>
              改用預設照片
            </button>
          ) : null}
        </div>
        <label className={LABEL}>
          圖片說明{hero ? '（必填）' : ''}
          <input
            name="heroAlt"
            value={values.heroAlt}
            onChange={(e) => setValues({ ...values, heroAlt: e.target.value })}
            className={INPUT}
            disabled={!hero || busy}
            placeholder={hero ? '例如：利瑪竇大樓外觀' : '上傳自訂圖片後再填'}
            aria-describedby="fe-hint-hero-alt"
          />
        </label>
        <p id="fe-hint-hero-alt" className="-mt-1 text-xs text-muted-foreground">
          看不到圖片的人（例如用螢幕報讀）會聽到這段文字。
        </p>
      </fieldset>
      <label className={LABEL}>
        標語第一行（首頁大標題）
        <input name="line1" value={values.line1} onChange={(e) => setValues({ ...values, line1: e.target.value })} className={INPUT} placeholder="空白＝用預設的字" disabled={busy} />
      </label>
      <label className={LABEL}>
        標語第二行（大標題下面的說明）
        <input name="line2" value={values.line2} onChange={(e) => setValues({ ...values, line2: e.target.value })} className={INPUT} placeholder="空白＝用預設的字" disabled={busy} />
      </label>
      <p className="text-xs text-muted-foreground">存了就生效，所有訪客重新整理就看到；三欄清空、改用預設照片就是恢復預設。</p>
      <div className="fe-actions">
        <button type="button" className="fe-btn" onClick={onCancel} disabled={busy}>
          取消
        </button>
        <button type="submit" className={BTN_SUBMIT} disabled={busy}>
          {pending ? '儲存中…' : '儲存'}
        </button>
      </div>
    </form>
  )
}
