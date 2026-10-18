'use client'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/navigation'
import { useId, useRef, useState, useTransition } from 'react'
import type { AvatarChoice, AvatarUser } from '@/application/accounts'
import type { DeclaredUpload } from '@/application/ops'
import type { Result } from '@/shared/result'

// 裁切視窗是獨立 chunk，選到檔案才載入，`/account` 首載不變（C3-04）。
const AvatarCropDialog = dynamic(() => import('./avatar-crop-dialog').then((m) => m.AvatarCropDialog), { ssr: false })

/**
 * 換頭像（SH-9；shared-r3 §2.0 `AvatarPicker` 契約，B 設計方案 §2.2.1 改成 `uploadTicketAction(input)`）。
 *
 * 兩種換法：
 * - **上傳**：選檔後先開裁切視窗（圓形取景框，C3-04），按「儲存」把取景範圍輸出成 512×512 JPEG；再向伺服器要上傳憑證（帶檔名、MIME、大小），再把位元組直接 POST 到 `/api/files/upload`
 *   （不走 Server Action：`bodySizeLimit` 1 MB 不改），伺服器縮成 256×256 WebP、清掉 EXIF；成功再 `submitAction({ fileId })`。
 * - **預設圖**：100 張裡挑一張，`submitAction({ preset })`。
 *
 * 規則全在伺服器（類型看檔頭、2 MB、本人）；這裡只先擋明顯不行的，省一趟來回。
 * 現在的頭像由使用方另外用 `UserAvatar` 顯示（Server Component）；換好後 `router.refresh()` 讓它重抓。
 * 掛載點：「我的帳號」（VB-10）。
 */

/** 與 `AVATAR_MAX_BYTES`（application/accounts/avatar.ts）相同；client 元件對 application 只能帶型別，伺服器另外再擋一次。 */
const MAX_BYTES = 2 * 1024 * 1024
const ACCEPT = ['image/png', 'image/jpeg', 'image/webp']
/** HEIC／HEIF 讓使用者選得到：進裁切視窗後瀏覽器畫不出來，會顯示「這個格式不能裁切」，不送出任何請求。 */
const CROP_ONLY = ['image/heic', 'image/heif']
const PRESETS = Array.from({ length: 100 }, (_, i) => i + 1)

const BUTTON =
  'press inline-flex h-10 items-center justify-center rounded-[4px] border border-border bg-background px-4 text-sm font-semibold text-foreground transition-colors hover:bg-accent disabled:opacity-60'

type Status = { kind: 'error' | 'done'; message: string } | null

function presetSrc(n: number): string {
  return `/avatars/${String(n).padStart(3, '0')}.webp`
}

export function AvatarPicker({
  current,
  uploadTicketAction,
  submitAction,
}: {
  current: AvatarUser
  uploadTicketAction: (input: DeclaredUpload) => Promise<Result<{ ticket: string }>>
  submitAction: (input: AvatarChoice) => Promise<Result<void>>
}) {
  const router = useRouter()
  const fileInput = useRef<HTMLInputElement>(null)
  const presetsId = useId()
  const [status, setStatus] = useState<Status>(null)
  const [showPresets, setShowPresets] = useState(false)
  const [pending, startTransition] = useTransition()
  const [cropping, setCropping] = useState<File | null>(null)
  const selectedPreset = current.avatarFileId ? null : current.avatarPreset

  function submit(choice: AvatarChoice, done: string) {
    startTransition(async () => {
      const result = await submitAction(choice)
      if (!result.ok) {
        setStatus({ kind: 'error', message: result.message })
        return
      }
      setStatus({ kind: 'done', message: done })
      router.refresh()
    })
  }

  function choose(file: File) {
    if (!ACCEPT.includes(file.type) && !CROP_ONLY.includes(file.type)) {
      setStatus({ kind: 'error', message: '只收 PNG、JPG、WebP 圖片。' })
      return
    }
    if (file.size > MAX_BYTES) {
      setStatus({ kind: 'error', message: '檔案超過 2 MB，請換一張小一點的圖片。' })
      return
    }
    setStatus(null)
    setCropping(file)
  }

  function upload(file: File) {
    if (file.size > MAX_BYTES) {
      setStatus({ kind: 'error', message: '裁切後的檔案超過 2 MB，請換一張圖片。' })
      return
    }
    startTransition(async () => {
      try {
        const ticket = await uploadTicketAction({ fileName: file.name, declaredMime: file.type, declaredSize: file.size })
        if (!ticket.ok) {
          setStatus({ kind: 'error', message: ticket.message })
          return
        }
        const response = await fetch(`/api/files/upload?ticket=${encodeURIComponent(ticket.receipt.ticket)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: file,
        })
        const uploaded = (await response.json().catch(() => null)) as
          | { ok: true; fileId: string }
          | { ok: false; message: string }
          | null
        if (!uploaded || !uploaded.ok) {
          setStatus({ kind: 'error', message: uploaded?.message ?? '上傳失敗，請重新選擇圖片。' })
          return
        }
        const result = await submitAction({ fileId: uploaded.fileId })
        if (!result.ok) {
          setStatus({ kind: 'error', message: result.message })
          return
        }
        setStatus({ kind: 'done', message: '頭像已更新。' })
        router.refresh()
      } catch {
        setStatus({ kind: 'error', message: '連線中斷，請重新選擇圖片。' })
      } finally {
        if (fileInput.current) fileInput.current.value = ''
      }
    })
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className={BUTTON + (pending ? ' pointer-events-none opacity-60' : ' cursor-pointer')}>
          上傳圖片
          <input
            ref={fileInput}
            type="file"
            accept={[...ACCEPT, ...CROP_ONLY].join(',')}
            className="sr-only"
            disabled={pending}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              if (file) choose(file)
            }}
          />
        </label>
        <button
          type="button"
          className={BUTTON}
          aria-expanded={showPresets}
          aria-controls={presetsId}
          onClick={() => setShowPresets((open) => !open)}
        >
          選預設圖
        </button>
      </div>
      <p className="text-xs text-muted-foreground">PNG、JPG、WebP，2 MB 以內；選圖後可拖動、縮放取景框；會移除拍攝位置等資訊。</p>
      {status ? (
        <p
          role={status.kind === 'error' ? 'alert' : 'status'}
          className={
            status.kind === 'error'
              ? 'rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle'
              : 'text-sm text-muted-foreground'
          }
        >
          {status.message}
        </p>
      ) : null}
      {cropping ? (
        <AvatarCropDialog
          file={cropping}
          onCancel={() => {
            setCropping(null)
            if (fileInput.current) fileInput.current.value = ''
          }}
          onReselect={() => {
            setCropping(null)
            if (fileInput.current) fileInput.current.value = ''
            fileInput.current?.click()
          }}
          onSave={(cropped) => {
            setCropping(null)
            upload(cropped)
          }}
        />
      ) : null}
      {showPresets ? (
        <ul id={presetsId} className="grid grid-cols-6 gap-2 sm:grid-cols-10" aria-label="預設頭像">
          {PRESETS.map((n) => (
            <li key={n}>
              <button
                type="button"
                disabled={pending}
                aria-label={`預設頭像 ${n}`}
                aria-pressed={selectedPreset === n}
                onClick={() => submit({ preset: n }, '頭像已更新。')}
                className="press block rounded-full ring-offset-2 ring-offset-background aria-pressed:ring-2 aria-pressed:ring-primary disabled:opacity-60"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- 同 UserAvatar：next/image 會輸出 style，被 CSP 擋 */}
                <img src={presetSrc(n)} alt="" width={40} height={40} loading="lazy" decoding="async" className="rounded-full" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
