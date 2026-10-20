import './home-hero-pixel.css'
import { mountPixelCanvas, type PixelMode } from './pixel-canvas'

/** 顏色、格距、速度同後台橫幅（規格④ §2.2、§3）；「淡」由 CSS 把整層壓到 50%。 */
const COLORS = '#8DB6E6,#8DB6E6,#BFDDF5,#F1BA4B,#F59A3C'

/**
 * 前台首頁橫幅的 Pixel（規格④ §3）。首頁（與 `/office-edit` 的同一個首頁元件）的漸層層帶 `[data-home-pixel]` 記號，
 * 頁首（`site-header.tsx`）看到記號、而且裝置符合條件時才 `import()` 這支（載入樁在 `dash-theme.tsx`，原因同 `fx/fuzzy-text.tsx`），
 * 在記號後面插入像素層、文字之前。首頁本身因此沒有前端元件，打包工具不會為它另開一份頁首共用程式（C4-08 Review，C4-09 回收）。
 * 伺服器端只有照片＋漸層；開了減少動態的不插入、也不下載這支。桌機常駐閃＋移入／點擊漣漪；手機只有點擊漣漪。
 */
export function mountHomeHeroPixel(marker: Element, mode: PixelMode): () => void {
  const root = document.createElement('div')
  root.className = 'home-hero-pixel'
  root.setAttribute('aria-hidden', 'true')
  Object.assign(root.dataset, { testid: 'home-hero-pixel', colors: COLORS, gap: '10', speed: '35' })
  const canvas = document.createElement('canvas')
  root.append(canvas)
  marker.after(root)
  const stop = mountPixelCanvas(root, canvas, mode)
  return () => {
    stop()
    root.remove()
  }
}
