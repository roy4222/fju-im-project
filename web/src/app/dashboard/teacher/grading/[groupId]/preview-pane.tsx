'use client'
import { useState, useSyncExternalStore, type ReactNode } from 'react'

/**
 * 三欄批改頁的「繳交版本」下拉＋檔案清單（左欄下半）與文件預覽（中欄）的開關（C1-12，設計方案① §7.3、AC-28）。
 *
 * 切版本、切檔案都在瀏覽器裡換（不換網址、不重新載入）：右欄評分卡還有沒存的輸入時不會被洗掉。
 * 只管「選了哪一版、哪個檔」：檔案列的大小與下載連結、每個檔的預覽窗格（`<iframe>` 或「請下載」）、各種空狀態都由
 * 伺服器元件 `submissions.tsx` 畫好傳進來，窗格只在選到時掛上（iframe 這時才建立、才打預覽端點）。
 * `[groupId]` 路由的 JS 預算很緊（`scripts/perf/budget.json`），所以這裡不放字樣、圖示與樣式判斷。
 */

/** 檔案清單一列：按鈕上的檔名、按鈕後面（大小、下載）、選到時中欄的預覽窗格。 */
export type ViewerFile = { readonly fileId: string; readonly name: string; readonly after: ReactNode; readonly pane: ReactNode }

/** 「繳交版本」下拉一項：選項文字、下拉下面的連結（填答內容）、這一版的檔案（第一個能預覽的排最前面時預設選它）。 */
export type ViewerVersion = {
  readonly versionNo: number
  readonly label: string
  readonly link: ReactNode
  readonly files: readonly ViewerFile[]
  /** 切到這一版時預設選的檔；沒有附件是 null。 */
  readonly firstFileId: string | null
}

const subscribeNothing = () => () => {}

export function SubmissionViewer({
  versions,
  opened,
  railTop,
  railHead,
  noFiles,
  railClassName,
  docClassName,
}: {
  /** 對應作業的正式版本（新到舊，至少一版）。 */
  versions: readonly ViewerVersion[]
  /** 網址指定 `?item=&version=` 時該版的填答內容（伺服器畫好）；沒有是 null。顯示在中欄，選檔案後換回預覽。 */
  opened: ReactNode
  /** 左欄上半（組別清單）。 */
  railTop: ReactNode
  /** 繳交區塊的標題（作業名）。 */
  railHead: ReactNode
  /** 這一版沒有附件時，左欄與中欄各顯示的一句。 */
  noFiles: { readonly rail: ReactNode; readonly pane: ReactNode }
  railClassName: string
  docClassName: string
}) {
  const [versionNo, setVersionNo] = useState(versions[0]!.versionNo)
  const version = versions.find((v) => v.versionNo === versionNo) ?? versions[0]!
  const [fileId, setFileId] = useState(versions[0]!.firstFileId)
  const [showOpened, setShowOpened] = useState(opened !== null)
  const file = version.files.find((f) => f.fileId === fileId)
  // 掛好後標 data-hydrated，e2e 等到它再操作（跟評分卡同一個做法）；畫面上沒有任何差別。
  const hydrated = useSyncExternalStore(subscribeNothing, () => true, () => false)

  return (
    <>
      <div className={railClassName}>
        {railTop}
        <section aria-label="繳交" data-hydrated={hydrated ? '' : undefined} data-testid="submission-picker" className="dash-card flex min-w-0 flex-col gap-3 p-4">
          {railHead}
          <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">
            繳交版本
            <select
              value={version.versionNo}
              onChange={(e) => {
                const next = versions.find((v) => v.versionNo === Number(e.target.value)) ?? versions[0]!
                setVersionNo(next.versionNo)
                setFileId(next.firstFileId)
                setShowOpened(false)
              }}
              className="h-9 w-full rounded-lg border border-border bg-card px-2 text-sm font-normal text-foreground"
            >
              {versions.map((v) => (
                <option key={v.versionNo} value={v.versionNo}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
          {version.link}
          {version.files.length === 0 ? (
            noFiles.rail
          ) : (
            <ul aria-label="檔案" className="flex flex-col gap-1">
              {version.files.map((f) => {
                const on = f === file && !showOpened
                return (
                  <li key={f.fileId} data-testid="attachment" className={`flex flex-col gap-1 rounded-lg px-2.5 py-2 ${on ? 'bg-accent' : 'bg-muted/50'}`}>
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => {
                        setFileId(f.fileId)
                        setShowOpened(false)
                      }}
                      className="min-w-0 text-left text-sm break-all text-foreground hover:underline"
                    >
                      {f.name}
                    </button>
                    {f.after}
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
      <section aria-label="文件預覽" data-testid="doc-pane" className={docClassName}>
        {showOpened && opened ? opened : file ? file.pane : noFiles.pane}
      </section>
    </>
  )
}
