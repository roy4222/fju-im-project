import './broken-page.css'
import Link from 'next/link'
import { BrokenFx } from '@/app/_ui/fx/fuzzy-text'
import { SiteShell } from '@/app/_ui/site-shell'

/** 輔大三色（規格④ §6）：橘 → 黃 → 淺藍，由左到右。canvas 讀 `data-gradient`，不輸出 `style=`。 */
const GRADIENT = '#E56E00,#F1BA4B,#8DB6E6'

/**
 * 一段抖動字（FuzzyText）：真文字（`h1`／`p`／`span`）一定在 DOM、不依量測；引擎掛上 canvas 後真文字改 sr-only。
 * 沒有引擎（減少動態、還沒載完）時看到的是 `.broken-text` 靜態三色漸層字。
 */
function Fuzzy({
  as: Tag,
  text,
  className,
  intensity,
  maxShift,
  fps,
}: {
  as: 'h1' | 'p' | 'span'
  text: string
  className: string
  intensity: number
  maxShift?: number
  fps?: number
}) {
  return (
    <div className="fuzzy-text" data-testid="fuzzy-text" data-fuzzy="" data-gradient={GRADIENT} data-intensity={intensity} data-max-shift={maxShift} data-fps={fps}>
      <Tag className={`broken-text ${className}`}>{text}</Tag>
    </div>
  )
}

/**
 * 404／403 共用的「壞掉」頁（規格④ §6）：頂列、頁尾照舊，只有 `main` 整塊深藍、上緣一條輔大三色線；
 * 「404」、標題、說明三段抖動三色字，按鈕偶爾跟著抖（特效在 `fx/fuzzy-engine.ts`，由 `BrokenFx` 按需載入）。
 * 兩頁的三段文字完全相同（沒權限就不要出現，Q35）；只差按鈕：404「回首頁」、403「回到自己的首頁」。
 * 真文字固定，所以同一角色不同拒絕原因的 `main` 文字相同（deny-not-found.spec）。
 * `staticFooter` 照傳給 `SiteShell`：根層 not-found 不讀 `site_texts`（C2-17）。
 */
export async function BrokenPage({
  action,
  staticFooter = false,
}: {
  action: { href: string; label: string }
  staticFooter?: boolean
}) {
  return (
    <SiteShell bare staticFooter={staticFooter}>
      <div className="broken-page" data-testid="not-found">
        <div className="broken-stripe" data-testid="broken-stripe" aria-hidden="true" />
        <div className="broken-body">
          <Fuzzy as="span" text="404" className="broken-code" intensity={0.35} />
          <Fuzzy as="h1" text="找不到這個頁面" className="broken-title" intensity={0.2} />
          <Fuzzy as="p" text="網址可能打錯了，或這個內容已經下架。" className="broken-desc" intensity={0.2} maxShift={1} fps={20} />
          <div className="broken-actions">
            <Link href={action.href} className="broken-glitch btn-fju h-11.5 px-7 text-[15px]">
              {action.label}
            </Link>
          </div>
        </div>
        <BrokenFx />
      </div>
    </SiteShell>
  )
}
