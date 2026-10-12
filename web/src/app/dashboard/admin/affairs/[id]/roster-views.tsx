import Link from 'next/link'
import { IconArrowLeft, IconFileText, IconUsersGroup } from '@tabler/icons-react'
import type { FormField } from '@/application/items'
import type { ItemWindow, MyVersionDetail, ReceiverDetail, ReopenEntry, RosterEntry } from '@/application/submissions'
import { ReopenPanel, type ReopenPanelProps } from '@/app/dashboard/admin/affairs/[id]/reopen-panel'
import { BTN_OUTLINE_SM, Panel, Pill, type PillTone } from '@/app/_ui/dashboard-kit'
import type { StatusTone } from '@/application/submissions'
import { answerFields, categoryOf, isFileField, receiverStatus } from '@/composition/submissions'
import { ChecksumDisclosure, ReceiptNoDisclosure } from '@/app/dashboard/_submissions/proof-disclosure'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute, formatTaipeiSecond } from '@/shared/time'

/**
 * 收件名單頁的幾塊畫面（票 18；票 21 補上整組一份：組別完成率、點進組別看版本與附件）。
 * 全部是 server component，沒有互動狀態：切換靠網址參數。
 */

export type ListKey = 'current' | 'exempt' | 'removed'

/** 狀態標籤的顏色（原型 StateBadge：已繳綠、草稿／待繳橘、逾期紅、其他灰）。 */
const PILL_TONE: Readonly<Record<StatusTone, PillTone>> = {
  success: 'success',
  brand: 'brand',
  muted: 'default',
  info: 'default',
  danger: 'danger',
}

const LIST_LABEL: Record<ListKey, string> = { current: '目前名單', exempt: '免繳', removed: '已不需要繳交（原名單移除）' }

const LIST_HINT: Record<ListKey, string> = {
  current: '需要繳交的名單；完成率就是用這份名單的總人數（組數）來算。',
  exempt: '系辦設為免繳（可恢復）：不算在需要繳交的總人數（組數）裡，也不算已完成。',
  removed: '已從繳交名單移除：完成率完全不算他們，回答保留、仍可查看。',
}

// ── 名單 ──────────────────────────────────────────────────────────────────────

export function RosterList({
  base,
  list,
  grouped,
  window,
  businessNow,
  individual,
}: {
  base: string
  list: ListKey
  grouped: Record<ListKey, readonly RosterEntry[]>
  window: ItemWindow
  businessNow: Date
  individual: boolean
}) {
  const rows = grouped[list]
  const who = individual ? '人' : '組'
  return (
    <Panel
      title={individual ? '各人狀態' : '各組狀態'}
      icon={<IconUsersGroup />}
      description={LIST_HINT[list]}
      headingId="roster-title"
      action={
        <nav aria-label="名單分類" className="flex flex-wrap gap-1.5">
          {(Object.keys(LIST_LABEL) as ListKey[]).map((key) => (
            <Link
              key={key}
              href={key === 'current' ? base : `${base}?list=${key}`}
              aria-current={key === list ? 'page' : undefined}
              className={cn(
                'inline-flex h-8 items-center gap-1 rounded-full border px-3 text-xs font-semibold transition-colors',
                key === list
                  ? 'border-primary/30 bg-primary-subtle text-primary-on-subtle'
                  : 'border-border text-muted-foreground hover:border-ink/40 hover:text-foreground',
              )}
            >
              {LIST_LABEL[key]}
              <span className="tabular-nums">{grouped[key].length}</span>
            </Link>
          ))}
        </nav>
      }
    >
      {rows.length === 0 ? (
        <p className="border-t border-border px-5 py-8 text-center text-sm text-muted-foreground">
          {list === 'current' ? `目前名單上沒有${who === '人' ? '人' : '組別'}。` : `沒有${LIST_LABEL[list]}的${who === '人' ? '人' : '組別'}。`}
        </p>
      ) : (
        <ul className="divide-y divide-border border-t border-border" aria-label={LIST_LABEL[list]} data-testid={`roster-${list}`}>
          {rows.map((entry) => (
            <RosterRow key={`${entry.receiverKind}:${entry.receiverId}`} base={base} entry={entry} window={window} businessNow={businessNow} individual={individual} />
          ))}
        </ul>
      )}
    </Panel>
  )
}

function RosterRow({
  base,
  entry,
  window,
  businessNow,
  individual,
}: {
  base: string
  entry: RosterEntry
  window: ItemWindow
  businessNow: Date
  individual: boolean
}) {
  const category = categoryOf(entry)
  const status = receiverStatus(window, entry, businessNow)
  const submitted = entry.latestVersionNo !== null
  // 補交中（W10）：已截止、但這一位的補交期限還沒到——狀態字照學生看到的「系辦開放補交到…」。
  const reopened = !submitted && !status.overdue && receiverStatus(window, { ...entry, reopenUntil: null }, businessNow).overdue
  let headline: string
  let tone: PillTone
  let detail: string
  if (category === 'removed') {
    headline = '已不需要繳交（原名單移除）'
    tone = 'default'
    detail = `${entry.eligibleTo ? formatTaipeiMinute(entry.eligibleTo) : ''}・${entry.removedReason ?? ''}・${
      submitted ? `回答保留（已繳第 ${entry.latestVersionNo} 次）` : '沒有正式送出過'
    }`
  } else if (category === 'exempt') {
    headline = '免繳'
    tone = 'default'
    detail = `理由：${entry.exemptReason ?? ''}`
  } else {
    headline = status.headline
    tone = PILL_TONE[status.tone]
    detail = submitted
      ? `${entry.latestSubmittedByName ?? ''} 於 ${entry.latestReceivedAt ? formatTaipeiMinute(entry.latestReceivedAt) : ''} 送出`
      : reopened
        ? status.detail
        : entry.hasDraft
          ? '有草稿，尚未正式送出'
          : status.overdue
            ? '已截止，沒有正式送出'
            : status.headline === '尚未開放'
              ? '尚未開放'
              : '還沒動'
  }
  const joined = `${entry.source === 'admin' ? '管理員加入' : '自動加入'}・${formatTaipeiMinute(entry.eligibleFrom)}`
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 transition-colors hover:bg-accent/40" data-testid="roster-row">
      {individual ? (
        <span className="w-20 shrink-0 text-xs font-semibold text-muted-foreground tabular-nums">{entry.studentNo ?? '—'}</span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">
          {individual ? entry.name : `${entry.name} 組`}
          {individual && entry.groupCode ? <span className="ml-2 text-xs font-normal text-muted-foreground">{entry.groupCode}</span> : null}
        </span>
        <span className="block text-xs text-muted-foreground tabular-nums" title="資格生效時間（系統時間）">
          {joined}
        </span>
      </span>
      <Pill tone={tone} data-testid="roster-status">
        {headline}
      </Pill>
      <span className="w-full text-xs text-muted-foreground tabular-nums sm:w-auto sm:min-w-[12rem]">{detail}</span>
      <Link
        href={`${base}?person=${entry.receiverId}`}
        className={BTN_OUTLINE_SM}
        aria-label={individual ? `查看 ${entry.name} 的回答` : `查看 ${entry.name} 組的繳交`}
      >
        檢視
      </Link>
    </li>
  )
}

// ── 右欄：欄位（收件進度在 `_submissions/completion-panel`，老師頁共用）────────────

export function FieldsPanel({ fields, schemaVersionNo }: { fields: readonly FormField[]; schemaVersionNo: number | null }) {
  const inputs = answerFields(fields)
  return (
    <Panel
      title="欄位"
      icon={<IconFileText />}
      description={`${inputs.length} 個${schemaVersionNo ? `・表單第 ${schemaVersionNo} 版` : ''}`}
      headingId="fields-title"
    >
      {inputs.length === 0 ? (
        <p className="border-t border-border px-5 py-3 text-sm text-muted-foreground">還沒有發布中的欄位。</p>
      ) : (
        <ul className="flex flex-col gap-1 border-t border-border px-5 py-3 text-sm">
          {inputs.map((f) => (
            <li key={f.key} className="flex items-center justify-between gap-2 py-1">
              <span className="truncate">{f.label}</span>
              {f.required ? <span className="shrink-0 text-[11px] text-destructive">必填</span> : null}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

// ── 點一個人 ──────────────────────────────────────────────────────────────────

export function ReceiverView({
  base,
  detail,
  window,
  businessNow,
  reopens,
  reopen,
}: {
  base: string
  detail: ReceiverDetail
  window: ItemWindow
  businessNow: Date
  /** 這位收件者的個別補交紀錄（W10，新的在前）。 */
  reopens: readonly ReopenEntry[]
  /** 能開補交時（已截止、目前名單上）給表單的參數；不能開是 null。 */
  reopen: Omit<ReopenPanelProps, 'group'> | null
}) {
  const { entry } = detail
  const category = categoryOf(entry)
  const status = receiverStatus(window, entry, businessNow)
  const group = entry.receiverKind === 'group'
  const back = category === 'current' ? base : `${base}?list=${category}`
  const banner =
    category === 'removed'
      ? `已從繳交名單移除（${entry.removedReason ?? ''}）・回答保留`
      : category === 'exempt'
        ? `免繳（系辦設定，可恢復）・理由：${entry.exemptReason ?? ''}`
        : status.headline
  return (
    <article className="dash-card overflow-hidden" data-testid="receiver-view">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 pt-4">
        <Link
          href={back}
          className="inline-flex items-center gap-1 text-[13px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
        >
          <IconArrowLeft aria-hidden className="size-4" /> {category === 'current' ? '繳交名單' : category === 'exempt' ? '免繳' : '已不需要繳交（原名單移除）'}
        </Link>
      </div>
      <header className="px-5 pb-3 pt-2">
        <h2 className="text-lg font-extrabold">
          {entry.name}
          <span className="ml-2 text-sm font-normal text-muted-foreground tabular-nums">
            {entry.studentNo ?? ''}
            {entry.groupCode ? `・${entry.groupCode}` : ''}
          </span>
        </h2>
        <p className="mt-1.5 text-sm font-semibold text-primary-on-subtle" data-testid="receiver-status">
          {banner}
        </p>
      </header>

      <section aria-labelledby="versions-title" className="border-t border-border px-5 py-4">
        <h3 id="versions-title" className="text-[15px] font-bold">
          正式送出的版本（{detail.versions.length}）
        </h3>
        {detail.versions.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">還沒有正式送出過。</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm" aria-label="正式送出的版本">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="py-2 font-medium">
                    第幾次
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    送出時間（臺灣時間）
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    送出者
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    表單
                  </th>
                  <th scope="col" className="py-2">
                    <span className="sr-only">動作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {detail.versions.map((v, index) => (
                  <tr key={v.versionNo} className="border-t border-border/70 transition-colors hover:bg-accent/40">
                    <td className="py-3 font-semibold tabular-nums">
                      第 {v.versionNo} 次
                      {index === 0 ? (
                        <span className="ml-2 rounded-full bg-success-subtle px-2 py-0.5 text-[11px] text-success-on-subtle">以此版為準</span>
                      ) : null}
                      {v.late ? <LateBadge /> : null}
                    </td>
                    <td className="py-3 tabular-nums">{formatTaipeiSecond(v.receivedBusinessAt)}</td>
                    <td className="py-3">{v.submittedByName}</td>
                    <td className="py-3 tabular-nums">第 {v.schemaVersionNo} 版</td>
                    <td className="py-1 text-right">
                      <Link
                        href={`${base}?person=${entry.receiverId}&version=${v.versionNo}`}
                        className={BTN_OUTLINE_SM}
                      >
                        看回答
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          {detail.draftUpdatedAt
            ? `另有一份草稿（最後儲存 ${formatTaipeiMinute(detail.draftUpdatedAt)}）。草稿只有${
                entry.receiverKind === 'group' ? '組員' : '本人'
              }看得到；這裡只列正式送出的版本。`
            : '沒有草稿。'}
        </p>
      </section>

      {reopen || reopens.length > 0 ? (
        <section aria-labelledby="reopen-title" className="border-t border-border px-5 py-4" data-testid="reopen-section">
          <h3 id="reopen-title" className="text-[15px] font-bold">
            補交
          </h3>
          {reopens.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">
              已經截止。{group ? '這一組' : '這位學生'}需要晚交時，可以單獨開放補交；其他人不受影響。
            </p>
          ) : (
            <ul className="mt-2 space-y-1.5 text-sm" aria-label="補交紀錄">
              {reopens.map((r, index) => (
                <li key={index} className="tabular-nums">
                  補交到 <strong>{formatTaipeiMinute(r.dueAt)}</strong>・理由：{r.reason}
                  <span className="text-xs text-muted-foreground">
                    （{r.createdByName} 於 {formatTaipeiMinute(r.createdAt)} 開放）
                  </span>
                </li>
              ))}
            </ul>
          )}
          {reopen ? <ReopenPanel {...reopen} group={group} /> : null}
        </section>
      ) : null}

      <section aria-labelledby="spans-title" className="border-t border-border px-5 py-4">
        <h3 id="spans-title" className="text-[15px] font-bold">
          名單紀錄
        </h3>
        <ul className="mt-2 space-y-1.5 text-sm">
          {detail.spans.map((s, index) => (
            <li key={index} className="tabular-nums">
              {formatTaipeiMinute(s.eligibleFrom)} {s.source === 'admin' ? '管理員加入' : '自動加入'}
              {s.exempt ? `・免繳（${s.exemptReason ?? ''}）` : ''}
              {s.eligibleTo ? `・${formatTaipeiMinute(s.eligibleTo)} 從繳交名單移除（${s.removedReason ?? ''}）` : '・目前在名單上'}
            </li>
          ))}
        </ul>
      </section>
    </article>
  )
}

export function VersionView({ base, detail, version }: { base: string; detail: ReceiverDetail; version: MyVersionDetail }) {
  const fields = answerFields(version.fields)
  const facts: [string, string][] = [
    ['送出時間', formatTaipeiSecond(version.receivedBusinessAt)],
    ['送出者', version.submittedByName],
    ['表單', `第 ${version.schemaVersionNo} 版`],
  ]
  return (
    <article className="dash-card flex flex-col gap-5 p-6" data-testid="version-view">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Link
          href={`${base}?person=${detail.entry.receiverId}`}
          className="inline-flex items-center gap-1 text-[13px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
        >
          <IconArrowLeft aria-hidden className="size-4" /> {detail.entry.name} 的版本
        </Link>
        <span className="text-xs text-muted-foreground">唯讀・這是第 {version.versionNo} 次送出當時的內容</span>
      </div>
      <h2 className="text-lg font-extrabold">
        {detail.entry.name}・第 {version.versionNo} 次
        {version.isLatest ? (
          <span className="ml-2 rounded-full bg-success-subtle px-2 py-0.5 text-[11px] text-success-on-subtle">以此版為準</span>
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
      <dl className="flex flex-col divide-y divide-border/70">
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
                    <a href={`/api/files/${file.fileId}`} className="break-all font-semibold text-primary underline-offset-2 hover:underline">
                      {file.name}
                    </a>
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
    </article>
  )
}

/** 截止後靠個別補交送出的版本（W10）。 */
function LateBadge() {
  return (
    <span className="ml-2 rounded-full bg-warning-subtle px-2 py-0.5 text-[11px] text-warning-on-subtle" data-testid="late-badge">
      補交
    </span>
  )
}
