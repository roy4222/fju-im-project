'use client'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  OUTPUT_SIZE,
  clampOffset,
  isSmallImage,
  scaleOf,
  sourceRect,
  zoomTo,
  MAX_ZOOM,
  MIN_ZOOM,
  type Offset,
} from './avatar-crop'

/**
 * 頭像裁切視窗（C3-04；設計方案 §3）。由 `AvatarPicker` 用 `next/dynamic` 在選到檔案後才載入。
 *
 * 取景框內部座標固定 256×256；畫面大小由 CSS class 決定（手機 220px），指標位移換算時乘上比例。
 * 照片與圓形遮罩都畫在 canvas 上，沒有任何 `style=`（CSP 不允許）。
 * 「儲存」把取景框範圍畫成 512×512 JPEG（品質 0.9）交回 `onSave`；伺服器的縮圖流程不變。
 */

const FRAME = 256
const KEY_STEP = 4
const ZOOM_STEP = 0.1

const BUTTON =
  'press inline-flex h-10 items-center justify-center rounded-[4px] border border-border bg-background px-4 text-sm font-semibold text-foreground transition-colors hover:bg-accent disabled:opacity-60'
const PRIMARY =
  'press inline-flex h-10 items-center justify-center rounded-[4px] bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60'

type View = { zoom: number; offset: Offset }

export function AvatarCropDialog({
  file,
  onSave,
  onCancel,
  onReselect,
}: {
  file: File
  onSave: (cropped: File) => void
  onCancel: () => void
  onReselect: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const bitmapRef = useRef<ImageBitmap | null>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinchStart = useRef<{ distance: number; zoom: number } | null>(null)
  const titleId = useId()
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null)
  const [failed, setFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [view, setView] = useState<View>({ zoom: MIN_ZOOM, offset: { x: 0, y: 0 } })
  const viewRef = useRef(view)
  viewRef.current = view

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  useEffect(() => {
    let cancelled = false
    createImageBitmap(file, { imageOrientation: 'from-image' }).then(
      (decoded) => {
        if (cancelled) {
          decoded.close()
          return
        }
        bitmapRef.current = decoded
        setBitmap(decoded)
      },
      () => {
        if (!cancelled) setFailed(true)
      },
    )
    return () => {
      cancelled = true
      bitmapRef.current?.close()
      bitmapRef.current = null
    }
  }, [file])

  // 畫預覽：照片＋圓形以外變暗＋圓框線。
  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context || !bitmap) return
    const image = { width: bitmap.width, height: bitmap.height }
    const scale = scaleOf(image, FRAME, view.zoom)
    const offset = clampOffset(view.offset, image, FRAME, view.zoom)
    context.clearRect(0, 0, FRAME, FRAME)
    context.drawImage(
      bitmap,
      FRAME / 2 + offset.x - (image.width * scale) / 2,
      FRAME / 2 + offset.y - (image.height * scale) / 2,
      image.width * scale,
      image.height * scale,
    )
    context.save()
    context.fillStyle = 'rgba(0, 0, 0, 0.55)'
    context.beginPath()
    context.rect(0, 0, FRAME, FRAME)
    context.arc(FRAME / 2, FRAME / 2, FRAME / 2 - 1, 0, Math.PI * 2, true)
    context.fill('evenodd')
    context.restore()
    context.strokeStyle = 'rgba(255, 255, 255, 0.9)'
    context.lineWidth = 2
    context.beginPath()
    context.arc(FRAME / 2, FRAME / 2, FRAME / 2 - 1, 0, Math.PI * 2)
    context.stroke()
  }, [bitmap, view])

  const apply = useCallback(
    (nextZoom: number, move?: Offset) => {
      const image = bitmapRef.current
      if (!image) return
      const size = { width: image.width, height: image.height }
      const current = viewRef.current
      const zoomed = zoomTo(nextZoom, current, size, FRAME)
      const offset = move
        ? clampOffset({ x: zoomed.offset.x + move.x, y: zoomed.offset.y + move.y }, size, FRAME, zoomed.zoom)
        : zoomed.offset
      setView({ zoom: zoomed.zoom, offset })
    },
    [],
  )

  // 滾輪縮放要 preventDefault（不讓頁面捲動），React 的 onWheel 是 passive，所以直接掛原生。
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    function onWheel(event: WheelEvent) {
      event.preventDefault()
      apply(viewRef.current.zoom * (event.deltaY < 0 ? 1.08 : 1 / 1.08))
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [apply])

  function unitsPerPixel(): number {
    const rect = canvasRef.current?.getBoundingClientRect()
    return rect && rect.width > 0 ? FRAME / rect.width : 1
  }

  function distance(): number {
    const [a, b] = [...pointers.current.values()]
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
  }

  async function save() {
    const image = bitmapRef.current
    if (!image) return
    setSaving(true)
    const size = { width: image.width, height: image.height }
    const rect = sourceRect(size, FRAME, view.zoom, view.offset)
    const output = document.createElement('canvas')
    output.width = OUTPUT_SIZE
    output.height = OUTPUT_SIZE
    const context = output.getContext('2d')
    if (!context) {
      setSaving(false)
      setFailed(true)
      return
    }
    context.imageSmoothingQuality = 'high'
    context.fillStyle = '#fff'
    context.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE)
    context.drawImage(image, rect.sx, rect.sy, rect.size, rect.size, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE)
    const blob = await new Promise<Blob | null>((resolve) => output.toBlob(resolve, 'image/jpeg', 0.9))
    if (!blob) {
      setSaving(false)
      setFailed(true)
      return
    }
    onSave(new File([blob], 'avatar.jpg', { type: 'image/jpeg' }))
  }

  const small = bitmap ? isSmallImage({ width: bitmap.width, height: bitmap.height }) : false

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        onCancel()
      }}
      onKeyDown={(event) => {
        // 原生 modal 的 Tab 走到頭會跳到瀏覽器介面；這裡首尾相接，焦點只在視窗內。
        if (event.key !== 'Tab') return
        const items = [...event.currentTarget.querySelectorAll<HTMLElement>('canvas[tabindex], input:not(:disabled), button:not(:disabled)')]
        const first = items[0]
        const last = items[items.length - 1]
        if (!first || !last) return
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }}
      className="m-auto w-[min(24rem,calc(100vw-2rem))] rounded-xl border border-border bg-popover p-0 shadow-xl backdrop:bg-ink/40"
    >
      <div className="space-y-4 p-5">
        <h2 id={titleId} className="text-base font-bold text-foreground">
          裁切頭像
        </h2>
        {failed ? (
          <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
            這個格式不能裁切，請換 JPG 或 PNG。
          </p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">拖動照片調整位置，用滑桿、滾輪或 + / - 縮放。</p>
            <canvas
              ref={canvasRef}
              width={FRAME}
              height={FRAME}
              tabIndex={0}
              role="img"
              aria-label="頭像取景框；方向鍵移動照片，加號與減號縮放"
              data-testid="avatar-crop-canvas"
              className="mx-auto block size-[220px] cursor-grab touch-none rounded-full bg-muted active:cursor-grabbing sm:size-64"
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId)
                pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
                if (pointers.current.size === 2) pinchStart.current = { distance: distance(), zoom: viewRef.current.zoom }
              }}
              onPointerMove={(event) => {
                const previous = pointers.current.get(event.pointerId)
                if (!previous) return
                pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
                if (pointers.current.size === 2 && pinchStart.current && pinchStart.current.distance > 0) {
                  apply(pinchStart.current.zoom * (distance() / pinchStart.current.distance))
                  return
                }
                const k = unitsPerPixel()
                apply(viewRef.current.zoom, { x: (event.clientX - previous.x) * k, y: (event.clientY - previous.y) * k })
              }}
              onPointerUp={(event) => {
                pointers.current.delete(event.pointerId)
                pinchStart.current = null
              }}
              onPointerCancel={(event) => {
                pointers.current.delete(event.pointerId)
                pinchStart.current = null
              }}
              onKeyDown={(event) => {
                const moves: Record<string, Offset> = {
                  ArrowLeft: { x: -KEY_STEP, y: 0 },
                  ArrowRight: { x: KEY_STEP, y: 0 },
                  ArrowUp: { x: 0, y: -KEY_STEP },
                  ArrowDown: { x: 0, y: KEY_STEP },
                }
                const move = moves[event.key]
                if (move) {
                  event.preventDefault()
                  apply(viewRef.current.zoom, move)
                } else if (event.key === '+' || event.key === '=') {
                  event.preventDefault()
                  apply(viewRef.current.zoom + ZOOM_STEP)
                } else if (event.key === '-' || event.key === '_') {
                  event.preventDefault()
                  apply(viewRef.current.zoom - ZOOM_STEP)
                }
              }}
            />
            <label className="flex items-center gap-3 text-sm text-foreground">
              縮放
              <input
                type="range"
                min={MIN_ZOOM}
                max={MAX_ZOOM}
                step={0.01}
                value={view.zoom}
                disabled={!bitmap}
                onChange={(event) => apply(Number(event.currentTarget.value))}
                className="w-full"
              />
            </label>
            {small ? <p className="text-xs text-muted-foreground">照片較小，會模糊。</p> : null}
          </>
        )}
      </div>
      <div className="flex justify-end gap-2 border-t border-border p-4">
        <button type="button" className={BUTTON} onClick={onReselect}>
          重選
        </button>
        <button type="button" className={BUTTON} onClick={onCancel}>
          取消
        </button>
        <button type="button" className={PRIMARY} disabled={!bitmap || failed || saving} onClick={save}>
          儲存
        </button>
      </div>
    </dialog>
  )
}
