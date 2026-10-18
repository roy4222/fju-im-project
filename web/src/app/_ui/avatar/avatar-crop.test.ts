import { describe, expect, it } from 'vitest'
import {
  MAX_ZOOM,
  baseScale,
  clampOffset,
  clampZoom,
  isSmallImage,
  sourceRect,
  zoomTo,
} from './avatar-crop'

const landscape = { width: 1200, height: 800 }
const FRAME = 256

describe('縮放夾限', () => {
  it('夾在 1 到上限之間', () => {
    expect(clampZoom(0.2)).toBe(1)
    expect(clampZoom(2.5)).toBe(2.5)
    expect(clampZoom(99)).toBe(MAX_ZOOM)
  })
})

describe('位移夾限', () => {
  it('zoom=1 時短邊方向不能動、長邊方向只能動到邊緣', () => {
    // 800 → 256，比例 0.32；1200 → 384，左右各多出 64。
    expect(baseScale(landscape, FRAME)).toBeCloseTo(0.32)
    expect(clampOffset({ x: 500, y: 500 }, landscape, FRAME, 1)).toEqual({ x: 64, y: 0 })
    expect(clampOffset({ x: -500, y: -500 }, landscape, FRAME, 1)).toEqual({ x: -64, y: 0 })
  })

  it('放大後可動範圍變大', () => {
    const o = clampOffset({ x: 9999, y: 9999 }, landscape, FRAME, 2)
    // 縮放 2 倍：寬 768、高 512 → 左右各 256、上下各 128。
    expect(o).toEqual({ x: 256, y: 128 })
  })

  it('方形照片 zoom=1 完全不能動', () => {
    expect(clampOffset({ x: 10, y: -10 }, { width: 200, height: 200 }, FRAME, 1)).toEqual({ x: 0, y: 0 })
  })
})

describe('改縮放', () => {
  it('縮小時位移跟著收回，仍蓋住取景框', () => {
    const big = zoomTo(3, { zoom: 1, offset: { x: 0, y: 0 } }, landscape, FRAME)
    const moved = { zoom: big.zoom, offset: clampOffset({ x: 300, y: 200 }, landscape, FRAME, big.zoom) }
    const back = zoomTo(1, moved, landscape, FRAME)
    expect(back.zoom).toBe(1)
    expect(back.offset).toEqual({ x: 64, y: 0 })
  })

  it('超過上限被夾住', () => {
    expect(zoomTo(50, { zoom: 1, offset: { x: 0, y: 0 } }, landscape, FRAME).zoom).toBe(MAX_ZOOM)
  })
})

describe('輸出矩形', () => {
  it('置中、zoom=1：取短邊大小的正方形在中間', () => {
    expect(sourceRect(landscape, FRAME, 1, { x: 0, y: 0 })).toEqual({ sx: 200, sy: 0, size: 800 })
  })

  it('照片往右拖到底：取景框看到的是照片左邊', () => {
    expect(sourceRect(landscape, FRAME, 1, { x: 64, y: 0 })).toEqual({ sx: 0, sy: 0, size: 800 })
    expect(sourceRect(landscape, FRAME, 1, { x: -64, y: 0 })).toEqual({ sx: 400, sy: 0, size: 800 })
  })

  it('放大 2 倍：範圍減半、永遠落在照片內', () => {
    const r = sourceRect(landscape, FRAME, 2, { x: 99999, y: -99999 })
    expect(r.size).toBe(400)
    expect(r.sx).toBeGreaterThanOrEqual(0)
    expect(r.sy).toBeGreaterThanOrEqual(0)
    expect(r.sx + r.size).toBeLessThanOrEqual(1200)
    expect(r.sy + r.size).toBeLessThanOrEqual(800)
  })
})

describe('小圖提示', () => {
  it('短邊小於 256 才提示', () => {
    expect(isSmallImage({ width: 200, height: 200 })).toBe(true)
    expect(isSmallImage({ width: 256, height: 900 })).toBe(false)
    expect(isSmallImage(landscape)).toBe(false)
  })
})
