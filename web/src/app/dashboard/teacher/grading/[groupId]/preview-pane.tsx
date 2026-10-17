'use client'
import { useState, useSyncExternalStore, type ReactNode } from 'react'

/**
 * 評分單組頁附件列的「在頁內檢視」開關（TE-B5，A-07）。只管開／關：列的內容、按鈕的兩種樣子和預覽窗格
 * （`<iframe>` 指向 `/api/files/{id}/preview`）都由伺服器元件 `submissions.tsx` 畫好傳進來，窗格只在打開時掛上
 * （iframe 這時才建立、才打預覽端點）。評分頁的 JS 預算很緊（`scripts/perf/budget.json`），所以這裡不放任何字樣與圖示。
 */

const subscribeNothing = () => () => {}

export function PreviewToggle({
  label,
  buttonClassName,
  children,
  after,
  pane,
}: {
  /** 按鈕內容：關著時 `closed`（「在頁內檢視」）、打開時 `open`（「收起檢視」）。 */
  label: { closed: ReactNode; open: ReactNode }
  buttonClassName: string
  /** 按鈕前：檔名、大小。 */
  children: ReactNode
  /** 按鈕後：「下載」連結。 */
  after: ReactNode
  /** 打開時掛在列下方的預覽窗格。 */
  pane: ReactNode
}) {
  const [open, setOpen] = useState(false)
  // 掛好後標 data-hydrated，e2e 等到它再按（跟評分卡同一個做法）；畫面上沒有任何差別。
  const hydrated = useSyncExternalStore(subscribeNothing, () => true, () => false)
  return (
    <li data-testid="attachment" data-hydrated={hydrated ? '' : undefined} className="flex flex-col gap-2 rounded-lg bg-muted/50 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {children}
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={buttonClassName}>
          {open ? label.open : label.closed}
        </button>
        {after}
      </div>
      {open ? pane : null}
    </li>
  )
}
