import Link from 'next/link'
import type { MyVersionDetail, VersionSummary } from '@/application/submissions'
import { answerFields, isFileField } from '@/composition/submissions'
import { ChecksumDisclosure, ReceiptNoDisclosure } from '@/app/dashboard/_submissions/proof-disclosure'
import { formatBytes } from '@/shared/format-bytes'
import { formatTaipeiSecond } from '@/shared/time'

/**
 * 繳交歷史的兩塊畫面：版本列表、某一版的內容（唯讀）。
 * 老師的收件頁與學生的「我的繳交紀錄」共用（票 22）；資料來自同一段查詢，所以組員、主指導、系辦看到的是同一份。
 * 附件連到 `/api/files/<id>`：每次下載都重新授權，列得出來的就是下載得到的。
 * 截止後靠系辦開的個別補交送出的版本標「補交」（W10b；資料來自模組 10 的 port，跟學生、系辦端同一個標記）。
 */

export function VersionTable({
  versions,
  hrefOf,
  label = '正式送出的版本',
  showSchemaVersion = true,
}: {
  versions: readonly VersionSummary[]
  hrefOf: (versionNo: number) => string
  label?: string
  /** `false` 時不顯示「表單 第 N 版」那一欄（學生端用，Q67）。 */
  showSchemaVersion?: boolean
}) {
  if (versions.length === 0) return <p className="py-6 text-center text-sm text-muted-foreground">還沒有正式送出過。</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[36rem] text-sm" aria-label={label}>
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="py-2 font-medium">
              第幾次
            </th>
            <th scope="col" className="py-2 font-medium">
              送出者
            </th>
            <th scope="col" className="py-2 font-medium">
              送出時間（臺灣時間）
            </th>
            {showSchemaVersion ? (
              <th scope="col" className="py-2 font-medium">
                表單
              </th>
            ) : null}
            <th scope="col" className="py-2">
              <span className="sr-only">動作</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {versions.map((v, index) => (
            <tr key={v.versionNo} className="border-t border-border">
              <td className="py-3 font-semibold tabular-nums">
                第 {v.versionNo} 次
                {index === 0 ? (
                  <span className="ml-2 rounded-full bg-primary-subtle px-2 py-0.5 text-[11px] text-primary-on-subtle">最新</span>
                ) : null}
                {v.late ? <LateBadge /> : null}
              </td>
              <td className="py-3">{v.submittedByName}</td>
              <td className="py-3 tabular-nums">{formatTaipeiSecond(v.receivedBusinessAt)}</td>
              {showSchemaVersion ? <td className="py-3 tabular-nums">第 {v.schemaVersionNo} 版</td> : null}
              <td className="py-1 text-right">
                <Link
                  href={hrefOf(v.versionNo)}
                  className="inline-flex h-10 items-center rounded-md px-3 text-sm font-semibold text-primary-on-subtle hover:bg-muted"
                >
                  查看內容
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function VersionContent({
  version,
  backHref,
  backLabel,
  title,
  showSchemaVersion = true,
}: {
  version: MyVersionDetail
  backHref: string
  backLabel: string
  title?: string
  /** `false` 時不顯示「表單 第 N 版」那一列（學生端用，Q67）。 */
  showSchemaVersion?: boolean
}) {
  const fields = answerFields(version.fields)
  const facts: [string, string][] = [
    ['送出時間', formatTaipeiSecond(version.receivedBusinessAt)],
    ['送出者', version.submittedByName],
    ...(showSchemaVersion ? [['表單', `第 ${version.schemaVersionNo} 版`] as [string, string]] : []),
  ]
  return (
    <div className="space-y-4" data-testid="version-view">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Link href={backHref} className="text-sm font-medium text-muted-foreground hover:text-ink">
          ← {backLabel}
        </Link>
        <span className="text-xs text-muted-foreground">唯讀・這是第 {version.versionNo} 次送出當時的內容</span>
      </div>
      <h2 className="text-lg font-semibold text-ink">
        {title ? `${title}・` : ''}第 {version.versionNo} 次
        {version.isLatest ? (
          <span className="ml-2 rounded-full bg-primary-subtle px-2 py-0.5 text-xs text-primary-on-subtle">以此版為準</span>
        ) : (
          <span className="ml-2 text-sm font-normal text-muted-foreground">已被後來的版本取代</span>
        )}
        {version.late ? <LateBadge /> : null}
      </h2>
      <dl className="grid gap-x-8 gap-y-2 border-y border-border py-3 text-sm sm:grid-cols-2">
        {facts.map(([k, v]) => (
          <div key={k} className="flex gap-4">
            <dt className="w-16 shrink-0 text-muted-foreground">{k}</dt>
            <dd className="font-semibold tabular-nums">{v}</dd>
          </div>
        ))}
        <ReceiptNoDisclosure requestId={version.requestId} className="sm:col-span-2" />
      </dl>
      <dl className="divide-y divide-border">
        {fields.map((f) => {
          const value = version.answers[f.key]
          const file = isFileField(f) ? version.files.find((x) => x.fieldKey === f.key) : undefined
          const text = value === undefined || isFileField(f) ? '' : typeof value === 'string' ? value : value.join('、')
          return (
            <div key={f.key} className="grid gap-1 py-3 sm:grid-cols-[12rem_1fr] sm:gap-6">
              <dt className="text-sm font-semibold">{f.label}</dt>
              <dd className="whitespace-pre-wrap text-sm">
                {file ? (
                  <span className="flex flex-wrap items-center gap-x-3">
                    <a href={`/api/files/${file.fileId}`} className="break-all font-semibold text-primary-on-subtle underline-offset-2 hover:underline">
                      {file.name}
                    </a>
                    <span className="text-xs text-muted-foreground tabular-nums">{formatBytes(file.sizeBytes)}</span>
                    <ChecksumDisclosure checksum={file.checksum} className="basis-full" />
                  </span>
                ) : (
                  text || <span className="text-muted-foreground">（未填）</span>
                )}
              </dd>
            </div>
          )
        })}
      </dl>
    </div>
  )
}

/** 截止後靠系辦開的個別補交送出的版本（W10）。 */
function LateBadge() {
  return (
    <span className="ml-2 rounded-full bg-warning-subtle px-2 py-0.5 text-[11px] text-warning-on-subtle" data-testid="late-badge">
      補交
    </span>
  )
}
