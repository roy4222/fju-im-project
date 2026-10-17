'use client'
import { useState, useSyncExternalStore, type ReactNode } from 'react'

/**
 * 評分單組頁左欄的一個附件列（TE-B5，B 設計方案 §5.2，A-07）：PDF 與圖片多一個「在頁內檢視」，
 * 按下在這一列下方打開預覽窗格，`<iframe>` 指向預覽端點 `/api/files/{id}/preview`（A-06；權限跟下載同一個函式，每次重算）。
 *
 * - PDF 的 iframe **不加 `sandbox` 屬性**：Chromium 在 sandbox 屬性下把 PDF 檢視器擋成錯誤頁（A-06 spike）；
 *   預覽回應自己帶 `default-src 'none'`、`nosniff`，只收白名單類型。
 * - 圖片加 `sandbox`（空值＝全部限制；圖片照樣顯示）。
 * - 不在預覽白名單上的類型（`previewable` false，例如 SVG）：預覽端點會 302 導下載，所以**不嵌入**，窗格只說請下載。
 *   白名單在伺服器（`composition/files` 的 `isPreviewableMime`），由 `submissions.tsx` 算好傳進來。
 *
 * 評分頁的 JS 預算很緊（`scripts/perf/budget.json`）：檔名、大小、「下載」連結與圖示都由伺服器元件 `submissions.tsx`
 * 畫好當 `children`／`icons` 傳進來，這裡只管開關與窗格，不另外帶圖示元件進 client bundle。
 */

const LINK = 'inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-primary-on-subtle underline-offset-2 hover:underline [&_svg]:size-3.5'
const subscribeNothing = () => () => {}

export function PreviewableAttachment({
  fileId,
  name,
  pdf,
  previewable,
  icons,
  download,
  children,
}: {
  fileId: string
  name: string
  /** 上傳時驗過內容的類型（`mime_detected`）是 PDF。 */
  pdf: boolean
  /** 預覽端點會 inline 回這個類型（PDF 與點陣圖；不含 SVG）。 */
  previewable: boolean
  /** 「在頁內檢視」與「收起檢視」的圖示（伺服器畫好）。 */
  icons: { open: ReactNode; close: ReactNode }
  /** 列的其餘內容：檔名、大小（放按鈕前）。 */
  children: ReactNode
  /** 「下載」連結（放按鈕後，伺服器畫好）。 */
  download: ReactNode
}) {
  const [open, setOpen] = useState(false)
  // 掛好後標 data-hydrated，e2e 等到它再按（跟評分卡同一個做法）；畫面上沒有任何差別。
  const hydrated = useSyncExternalStore(subscribeNothing, () => true, () => false)
  const href = `/api/files/${fileId}`

  return (
    <li data-testid="attachment" data-hydrated={hydrated ? '' : undefined} className="flex flex-col gap-2 rounded-lg bg-muted/50 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {children}
        <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className={LINK}>
          {open ? icons.close : icons.open}
          {open ? '收起檢視' : '在頁內檢視'}
          <span className="sr-only">：{name}</span>
        </button>
        {download}
      </div>
      {open ? (
        <div data-testid="preview-pane" role="region" aria-label={`檢視：${name}`} className="overflow-hidden rounded-lg border border-border bg-card">
          {previewable ? (
            <iframe
              src={`${href}/preview`}
              title={name}
              // PDF 不能加 sandbox（見檔頭）；圖片全部限制。
              sandbox={pdf ? undefined : ''}
              className={`block w-full bg-white ${pdf ? 'h-[75vh] min-h-[420px]' : 'h-[60vh] min-h-[240px]'}`}
            />
          ) : (
            <p className="px-3 py-4 text-sm text-muted-foreground">
              這種檔案不能在頁內檢視，請
              <a href={href} className="font-semibold text-primary-on-subtle underline underline-offset-2">
                下載
              </a>
              後開啟。
            </p>
          )}
        </div>
      ) : null}
    </li>
  )
}
