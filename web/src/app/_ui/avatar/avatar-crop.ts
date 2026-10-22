/**
 * 頭像裁切的純函式（C3-04；設計方案 §3）。
 *
 * 座標約定：取景框是邊長 `frame` 的正方形（畫面上用圓形遮罩顯示）；照片以「蓋滿取景框」的最小比例為基準（zoom = 1），
 * `offset` 是照片中心相對取景框中心的位移（取景框單位）。位移一律夾在「照片不露出空白」的範圍內。
 */

export type Size = { width: number; height: number }
export type Offset = { x: number; y: number }
export type SourceRect = { sx: number; sy: number; size: number }

export const MIN_ZOOM = 1
export const MAX_ZOOM = 4
/** 輸出邊長（px）；伺服器再縮成 256×256 WebP。 */
export const OUTPUT_SIZE = 512
/** 照片短邊小於這個值，輸出放大後會模糊，視窗提示一句。 */
export const SMALL_EDGE = 256

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function clampZoom(zoom: number): number {
  return clamp(zoom, MIN_ZOOM, MAX_ZOOM)
}

/** zoom = 1 時，每個照片像素佔幾個取景框單位（短邊剛好蓋滿取景框）。 */
export function baseScale(image: Size, frame: number): number {
  return frame / Math.min(image.width, image.height)
}

export function scaleOf(image: Size, frame: number, zoom: number): number {
  return baseScale(image, frame) * clampZoom(zoom)
}

/** 位移夾限：縮放後的照片在每個方向都要蓋住取景框。 */
export function clampOffset(offset: Offset, image: Size, frame: number, zoom: number): Offset {
  const scale = scaleOf(image, frame, zoom)
  const maxX = Math.max(0, (image.width * scale - frame) / 2)
  const maxY = Math.max(0, (image.height * scale - frame) / 2)
  // `+ 0` 把 -0 正規化成 0。
  return { x: clamp(offset.x, -maxX, maxX) + 0, y: clamp(offset.y, -maxY, maxY) + 0 }
}

/** 改縮放時以取景框中心為軸心：位移跟著等比例縮放，再夾限。 */
export function zoomTo(nextZoom: number, current: { zoom: number; offset: Offset }, image: Size, frame: number) {
  const zoom = clampZoom(nextZoom)
  const ratio = zoom / current.zoom
  const offset = clampOffset({ x: current.offset.x * ratio, y: current.offset.y * ratio }, image, frame, zoom)
  return { zoom, offset }
}

/** 取景框在原照片上對應的正方形（照片像素）。 */
export function sourceRect(image: Size, frame: number, zoom: number, offset: Offset): SourceRect {
  const scale = scaleOf(image, frame, zoom)
  const o = clampOffset(offset, image, frame, zoom)
  const size = frame / scale
  return {
    sx: image.width / 2 - (frame / 2 + o.x) / scale,
    sy: image.height / 2 - (frame / 2 + o.y) / scale,
    size,
  }
}

export function isSmallImage(image: Size): boolean {
  return Math.min(image.width, image.height) < SMALL_EDGE
}
