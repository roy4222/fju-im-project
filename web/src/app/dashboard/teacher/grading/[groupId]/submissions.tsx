import Link from 'next/link'
import type { ReactNode } from 'react'
import { IconDownload, IconExternalLink, IconPaperclip } from '@tabler/icons-react'
import type { SubmissionRow } from '@/app/dashboard/teacher/grading/[groupId]/bench-types'
import { Panel, PanelEmpty } from '@/app/dashboard/teacher/_ui/dash'
import { formatBytes } from '@/shared/format-bytes'
import { formatTaipeiMinute } from '@/shared/time'

/**
 * 評分單組頁的左欄「本組正式繳交」（TE-06b，Q78；A 不內嵌）。伺服器元件。
 *
 * 每個整組作業最新一次正式送出的版本一列：作業名、第 N 版、送出時間、附件清單。附件在初開頁就列出
 * （TE-11 `teacherBenchPage.submissions[].attachments` 一次帶回，不逐份讀版本內容）。
 * - PDF（偵測到的 `mime` 是 `application/pdf`）：「在新分頁開啟 PDF」。走既有下載介面 `/api/files/{id}`，
 *   回應仍是 `content-disposition: attachment`，所以多數瀏覽器會**下載**而不是在分頁裡顯示。
 * - 其他附件：「下載」。
 * - 不放 `src` 指向 `/api/files/…` 的 `<iframe>`／`<img>`：頁面 CSP 的 `frame-src` 沒有 `'self'`，內嵌預覽是 B 的 TE-B5。
 * 點作業名（`?item=&version=`）時由 `opened` 顯示該版的文字內容（既有行為）。
 */

const LINK = 'inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-primary-on-subtle underline-offset-2 hover:underline [&_svg]:size-3.5'

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
                  {v.attachments.map((f) => (
                    <li key={f.fileId} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-muted/50 px-3 py-2">
                      <span className="min-w-0 flex-1 break-all text-sm text-foreground">{f.name}</span>
                      <span className="tabular shrink-0 text-xs text-muted-foreground">{formatBytes(f.sizeBytes)}</span>
                      {f.mime === 'application/pdf' ? (
                        <a href={`/api/files/${f.fileId}`} target="_blank" rel="noopener noreferrer" className={LINK}>
                          <IconExternalLink aria-hidden />
                          在新分頁開啟 PDF<span className="sr-only">：{f.name}</span>
                        </a>
                      ) : (
                        <a href={`/api/files/${f.fileId}`} className={LINK}>
                          <IconDownload aria-hidden />
                          下載<span className="sr-only">：{f.name}</span>
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}
