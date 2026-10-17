import Link from 'next/link'
import type { ReactNode } from 'react'
import { IconDownload, IconEye, IconPaperclip, IconX } from '@tabler/icons-react'
import type { SubmissionRow } from '@/app/dashboard/teacher/grading/[groupId]/bench-types'
import { PreviewToggle } from '@/app/dashboard/teacher/grading/[groupId]/preview-pane'
import { Panel, PanelEmpty } from '@/app/dashboard/teacher/_ui/dash'
import { isPreviewableMime } from '@/composition/files'
import { formatBytes } from '@/shared/format-bytes'
import { formatTaipeiMinute } from '@/shared/time'

/**
 * 評分單組頁的左欄「本組正式繳交」（TE-06b，Q78；B 階段 TE-B5 加頁內檢視）。伺服器元件。
 *
 * 每個整組作業最新一次正式送出的版本一列：作業名、第 N 版、送出時間、附件清單。附件在初開頁就列出
 * （TE-11 `teacherBenchPage.submissions[].attachments` 一次帶回，不逐份讀版本內容）。
 * - PDF 與圖片（偵測到的 `mime`）：「在頁內檢視」＋「下載」。按下在該列下方開預覽窗格（開關是 `preview-pane.tsx`，client；
 *   窗格在這裡畫好傳進去，打開才掛上），`<iframe>` 指向預覽端點 `/api/files/{id}/preview`（A-06：inline、只讓本站嵌入；
 *   頁面 CSP `frame-src` 有 `'self'`）。
 *   - PDF 的 iframe **不加 `sandbox` 屬性**：Chromium 在 sandbox 屬性下把 PDF 檢視器擋成錯誤頁（A-06 spike）；
 *     預覽回應自己帶 `default-src 'none'`、`nosniff`，只收白名單類型。圖片加 `sandbox`（空值＝全部限制；照樣顯示）。
 *   - SVG 等不在預覽白名單（`isPreviewableMime`）的圖片：窗格只說請下載，不嵌入（預覽端點對它們會 302 導下載）。
 * - 其他附件：只有「下載」（`/api/files/{id}`，`attachment`）。
 * 點作業名（`?item=&version=`）時由 `opened` 顯示該版的文字內容（既有行為）。
 */

const LINK = 'inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-primary-on-subtle underline-offset-2 hover:underline [&_svg]:size-3.5'

/** 預覽窗格：可預覽的嵌 iframe（PDF 不加 sandbox、圖片全部限制），其他只說請下載。 */
function PreviewPane({ fileId, name, mime }: { fileId: string; name: string; mime: string }) {
  const href = `/api/files/${fileId}`
  const pdf = mime === 'application/pdf'
  return (
    <div data-testid="preview-pane" role="region" aria-label={`檢視：${name}`} className="overflow-hidden rounded-lg border border-border bg-card">
      {isPreviewableMime(mime) ? (
        <iframe
          src={`${href}/preview`}
          title={name}
          sandbox={pdf ? undefined : ''}
          className={pdf ? 'block h-[75vh] min-h-[420px] w-full bg-white' : 'block h-[60vh] min-h-[240px] w-full bg-white'}
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
  )
}

/** 每個作業只留最新一版（`submissions` 依作業、版本新到舊排）。 */
export function latestByItem(rows: readonly SubmissionRow[]): SubmissionRow[] {
  return rows.filter((v, i) => rows.findIndex((x) => x.itemId === v.itemId) === i)
}

export function GroupSubmissions({
  rows,
  benchHref,
  opened,
}: {
  rows: readonly SubmissionRow[]
  /** 回到本頁（目前階段）的網址；點作業名時在後面加 `&item=&version=`。 */
  benchHref: string
  /** 指定 `?item=&version=` 時該版的內容（`VersionContent`）；沒有指定是 null。 */
  opened: ReactNode
}) {
  const latest = latestByItem(rows)
  return (
    <Panel title="本組正式繳交" icon={<IconPaperclip />} description="每個整組作業最新一次正式送出的版本與附件">
      {opened ? (
        <div className="border-t border-border px-5 py-4">{opened}</div>
      ) : latest.length === 0 ? (
        <PanelEmpty icon={<IconPaperclip />} title="這一組還沒有正式送出任何整組作業" hint="草稿看不到；附件每次下載都重新確認你還是評分老師。" />
      ) : (
        <ul aria-label="本組正式繳交" className="divide-y divide-border">
          {latest.map((v) => (
            <li key={v.itemId} data-testid="group-submission" className="flex flex-col gap-2 px-5 py-4">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <Link
                  href={`${benchHref}&item=${v.itemId}&version=${v.versionNo}`}
                  className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground underline-offset-2 hover:underline"
                >
                  {v.title}
                </Link>
                <span className="tabular text-xs text-muted-foreground">
                  第 {v.versionNo} 版・{v.submittedByName}・{formatTaipeiMinute(v.receivedBusinessAt)}
                </span>
              </div>
              {v.attachments.length === 0 ? (
                <p className="text-xs text-muted-foreground">沒有附件</p>
              ) : (
                <ul aria-label={`${v.title}的附件`} className="flex flex-col gap-1.5">
                  {v.attachments.map((f) => {
                    const info = (
                      <>
                        <span className="min-w-0 flex-1 break-all text-sm text-foreground">{f.name}</span>
                        <span className="tabular shrink-0 text-xs text-muted-foreground">{formatBytes(f.sizeBytes)}</span>
                      </>
                    )
                    const download = (
                      <a href={`/api/files/${f.fileId}`} className={LINK}>
                        <IconDownload aria-hidden />
                        下載<span className="sr-only">：{f.name}</span>
                      </a>
                    )
                    return f.mime === 'application/pdf' || f.mime.startsWith('image/') ? (
                      <PreviewToggle
                        key={f.fileId}
                        buttonClassName={LINK}
                        label={{
                          closed: (
                            <>
                              <IconEye aria-hidden />
                              在頁內檢視<span className="sr-only">：{f.name}</span>
                            </>
                          ),
                          open: (
                            <>
                              <IconX aria-hidden />
                              收起檢視<span className="sr-only">：{f.name}</span>
                            </>
                          ),
                        }}
                        after={download}
                        pane={<PreviewPane fileId={f.fileId} name={f.name} mime={f.mime} />}
                      >
                        {info}
                      </PreviewToggle>
                    ) : (
                      <li key={f.fileId} data-testid="attachment" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-muted/50 px-3 py-2">
                        {info}
                        {download}
                      </li>
                    )
                  })}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}
