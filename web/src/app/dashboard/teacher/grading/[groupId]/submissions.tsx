import type { ReactNode } from 'react'
import type { SubmissionRow } from '@/app/dashboard/teacher/grading/[groupId]/bench-types'
import { SubmissionViewer, type ViewerVersion } from '@/app/dashboard/teacher/grading/[groupId]/preview-pane'
import type { VersionAttachment } from '@/application/submissions'
import { isPreviewableMime } from '@/composition/files'
import { cn } from '@/shared/cn'
import { formatBytes } from '@/shared/format-bytes'
import { formatTaipeiMinute } from '@/shared/time'

/**
 * 三欄批改頁的左欄下半與中欄（C1-12，設計方案① §7.3、AC-28／AC-28a／AC-29）。伺服器元件。
 *
 * - 這個評分項目**有對應作業**：`rows` 只有那份作業的正式版本（新到舊；C1-04 的 `teacherBenchPage` 伺服器端就只回這份，
 *   沒有「本組全部繳交」的退路）。整理成「繳交版本」下拉的選項與每版的檔案，交給 `SubmissionViewer`（client）切換與預覽。
 * - **沒有對應作業**：左欄沒有任何版本；中欄是評分項目的標題＋說明＋「這個項目不看作業，直接填分」。
 *
 * 左右兩塊各是外層 grid 的一格（`railClassName`／`docClassName` 由頁面給），左欄上半的組別清單（`railTop`）一起放進左格。
 */

const LINK = 'inline-flex shrink-0 items-center text-xs font-semibold text-primary-on-subtle underline-offset-2 hover:underline'

/** 能不能在頁內嵌入：偵測到的型別在預覽白名單裡才嵌（PDF 不加 sandbox、圖片全部限制）；SVG 等一律只給下載。 */
function previewKind(mime: string): 'pdf' | 'image' | null {
  if (!isPreviewableMime(mime)) return null
  return mime === 'application/pdf' ? 'pdf' : 'image'
}

function DocNote({ children }: { children: ReactNode }) {
  return <p className="px-6 py-16 text-center text-sm font-semibold text-muted-foreground">{children}</p>
}

/**
 * 中欄的一個檔案預覽（TE-B5 的做法搬到中欄）：`<iframe>` 指向 `/api/files/{id}/preview`（A-06：inline、只讓本站嵌入；
 * 頁面 CSP `frame-src` 有 `'self'`）。
 * - PDF 的 iframe **不加 `sandbox` 屬性**：Chromium 在 sandbox 屬性下把 PDF 檢視器擋成錯誤頁（A-06 spike）；
 *   預覽回應自己帶 `default-src 'none'`、`nosniff`，只收白名單類型。圖片加 `sandbox`（空值＝全部限制；照樣顯示）。
 * - 不在預覽白名單的檔案（SVG、docx…）：只說請下載，不嵌入（預覽端點對它們會 302 導下載）。
 * - 窄螢幕（三欄變上下）：不嵌入，改成「開啟文件」按鈕（在新分頁開預覽端點）。
 */
function FilePane({ file }: { file: VersionAttachment }) {
  const href = `/api/files/${file.fileId}`
  const kind = previewKind(file.mime)
  return (
    <div data-testid="preview-pane" className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <p className="min-w-0 truncate text-sm font-semibold text-foreground">{file.name}</p>
        <a href={href} className={LINK}>
          下載<span className="sr-only">：{file.name}</span>
        </a>
      </div>
      {kind ? (
        <>
          <iframe
            src={`${href}/preview`}
            title={file.name}
            sandbox={kind === 'pdf' ? undefined : ''}
            className={cn('hidden w-full bg-white xl:block', kind === 'pdf' ? 'h-[calc(100dvh-9rem)] min-h-[480px]' : 'h-[60vh] min-h-[240px]')}
          />
          <p className="px-4 py-4 xl:hidden">
            <a href={`${href}/preview`} target="_blank" rel="noopener" className="inline-flex h-9 items-center rounded-lg bg-primary px-4 text-sm font-bold text-primary-foreground">
              開啟文件<span className="sr-only">：{file.name}</span>
            </a>
          </p>
        </>
      ) : (
        <p className="px-4 py-6 text-sm text-muted-foreground">
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

function toViewerVersion(v: SubmissionRow, benchHref: string): ViewerVersion {
  // 預設選第一個能嵌入的檔，沒有就第一個。
  const first = v.attachments.find((f) => previewKind(f.mime)) ?? v.attachments[0]
  return {
    versionNo: v.versionNo,
    label: `第 ${v.versionNo} 版・${formatTaipeiMinute(v.receivedBusinessAt)}・${v.submittedByName}`,
    link: (
      <a href={`${benchHref}&item=${v.itemId}&version=${v.versionNo}`} className={LINK}>
        看這一版的填答內容
      </a>
    ),
    firstFileId: first?.fileId ?? null,
    files: v.attachments.map((f) => ({
      fileId: f.fileId,
      name: f.name,
      after: (
        <span className="flex items-center justify-between gap-2">
          <span className="tabular text-xs text-muted-foreground">{formatBytes(f.sizeBytes)}</span>
          <a href={`/api/files/${f.fileId}`} className={LINK}>
            下載<span className="sr-only">：{f.name}</span>
          </a>
        </span>
      ),
      pane: <FilePane file={f} />,
    })),
  }
}

export function StageDocuments({
  linkedItem,
  stageName,
  description,
  rows,
  benchHref,
  opened,
  railTop,
  railClassName,
  docClassName,
}: {
  /** 這個評分項目對應的作業；沒有是 null。 */
  linkedItem: { readonly itemId: string; readonly title: string } | null
  stageName: string
  /** 系辦寫給老師的說明；沒有是 null。 */
  description: string | null
  rows: readonly SubmissionRow[]
  /** 回到本頁（目前評分項目）的網址；填答內容在後面加 `&item=&version=`。 */
  benchHref: string
  /** 指定 `?item=&version=` 時該版的內容（`VersionContent`）；沒有指定是 null。 */
  opened: ReactNode
  railTop: ReactNode
  railClassName: string
  docClassName: string
}) {
  if (!linkedItem) {
    return (
      <>
        <div className={railClassName}>{railTop}</div>
        <section aria-label="文件預覽" data-testid="doc-pane" className={docClassName}>
          <div data-testid="no-linked-item" className="flex flex-col gap-2 px-6 py-12">
            <h2 className="text-lg font-extrabold text-foreground">{stageName}</h2>
            {description ? <p className="text-sm whitespace-pre-line text-foreground">{description}</p> : null}
            <p className="text-sm text-muted-foreground">這個項目不看作業，直接填分。</p>
          </div>
        </section>
      </>
    )
  }
  const railHead = <h2 className="truncate text-sm font-bold text-foreground">{linkedItem.title}</h2>
  const versions = rows.filter((v) => v.itemId === linkedItem.itemId).map((v) => toViewerVersion(v, benchHref))
  if (versions.length === 0) {
    return (
      <>
        <div className={railClassName}>
          {railTop}
          <section aria-label="繳交" data-testid="submission-picker" className="dash-card flex min-w-0 flex-col gap-3 p-4">
            {railHead}
            <p className="text-xs text-muted-foreground">這一組還沒有正式送出這份作業。</p>
          </section>
        </div>
        <section aria-label="文件預覽" data-testid="doc-pane" className={docClassName}>
          <DocNote>這一組還沒有正式送出「{linkedItem.title}」，沒有文件可以預覽。</DocNote>
        </section>
      </>
    )
  }
  return (
    <SubmissionViewer
      versions={versions}
      opened={opened ? <div className="px-5 py-4">{opened}</div> : null}
      railTop={railTop}
      railHead={railHead}
      noFiles={{ rail: <p className="text-xs text-muted-foreground">這一版沒有附件</p>, pane: <DocNote>這一版沒有附件。</DocNote> }}
      railClassName={railClassName}
      docClassName={docClassName}
    />
  )
}
