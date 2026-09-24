import Link from 'next/link'
import type { FormField } from '@/application/items'
import type { Completion, ItemWindow, MyVersionDetail, ReceiverDetail, RosterEntry } from '@/application/submissions'
import { TONE_CLASS } from '@/app/dashboard/student/affairs/tone'
import { answerFields, categoryOf, receiverStatus } from '@/composition/submissions'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute, formatTaipeiSecond } from '@/shared/time'

/** 收件名單頁的幾塊畫面（票 18）。全部是 server component，沒有互動狀態：切換靠網址參數。 */

export type ListKey = 'current' | 'exempt' | 'removed'

const LIST_LABEL: Record<ListKey, string> = { current: '目前名單', exempt: '免填', removed: '已移出' }

const LIST_HINT: Record<ListKey, string> = {
  current: '應交的人；完成率的分母。',
  exempt: '系辦設為免填：不算分母，也不算已完成。',
  removed: '已經不在名單上：不算分子分母，回答保留、仍可查看。',
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
    <section aria-labelledby="roster-title" className="rounded-card border border-border bg-background">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-4">
        <h2 id="roster-title" className="text-base font-semibold text-ink">
          收件名單
        </h2>
        <p className="text-xs text-muted-foreground">{LIST_HINT[list]}</p>
      </div>
      <nav aria-label="名單分類" className="mt-3 flex gap-1 overflow-x-auto border-b border-border px-3">
        {(Object.keys(LIST_LABEL) as ListKey[]).map((key) => (
          <Link
            key={key}
            href={key === 'current' ? base : `${base}?list=${key}`}
            aria-current={key === list ? 'page' : undefined}
            className={cn(
              '-mb-px inline-flex h-11 shrink-0 items-center gap-1.5 border-b-2 px-4 text-sm font-semibold',
              key === list ? 'border-primary text-ink' : 'border-transparent text-muted-foreground hover:text-ink',
            )}
          >
            {LIST_LABEL[key]}
            <span className="tabular-nums text-xs font-medium opacity-80">{grouped[key].length}</span>
          </Link>
        ))}
      </nav>
      {rows.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-muted-foreground">
          {list === 'current' ? `目前名單上沒有${who === '人' ? '人' : '組別'}。` : `沒有${LIST_LABEL[list]}的${who === '人' ? '人' : '組別'}。`}
        </p>
      ) : (
        <ul className="divide-y divide-border" aria-label={LIST_LABEL[list]} data-testid={`roster-${list}`}>
          {rows.map((entry) => (
            <RosterRow key={`${entry.receiverKind}:${entry.receiverId}`} base={base} entry={entry} window={window} businessNow={businessNow} individual={individual} />
          ))}
        </ul>
      )}
    </section>
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
  let headline: string
  let tone: string
  let detail: string
  if (category === 'removed') {
    headline = '已移出'
    tone = 'text-muted-foreground'
    detail = `${entry.eligibleTo ? formatTaipeiMinute(entry.eligibleTo) : ''}・${entry.removedReason ?? ''}・${
      submitted ? `回答保留（已繳 v${entry.latestVersionNo}）` : '沒有正式送出過'
    }`
  } else if (category === 'exempt') {
    headline = '免填'
    tone = 'text-muted-foreground'
    detail = `理由：${entry.exemptReason ?? ''}`
  } else {
    headline = status.headline
    tone = TONE_CLASS[status.tone]
    detail = submitted
      ? `${entry.latestSubmittedByName ?? ''} 於 ${entry.latestReceivedAt ? formatTaipeiMinute(entry.latestReceivedAt) : ''} 送出`
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
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3" data-testid="roster-row">
      <span className="w-20 shrink-0 text-xs font-semibold text-muted-foreground tabular-nums">
        {individual ? (entry.studentNo ?? '—') : entry.name}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-ink">
          {individual ? entry.name : `${entry.name} 組`}
          {individual && entry.groupCode ? <span className="ml-2 text-xs font-normal text-muted-foreground">{entry.groupCode}</span> : null}
        </span>
        <span className="block text-xs text-muted-foreground tabular-nums" title="資格生效時間（業務時間）">
          {joined}
        </span>
      </span>
      <span className="w-full sm:w-auto sm:min-w-[14rem]">
        <span className={cn('block text-sm font-semibold', tone)} data-testid="roster-status">
          {headline}
        </span>
        <span className="block text-xs text-muted-foreground tabular-nums">{detail}</span>
      </span>
      {individual ? (
        <Link
          href={`${base}?person=${entry.receiverId}`}
          className="inline-flex h-10 shrink-0 items-center rounded-md border border-border px-3 text-sm font-medium text-ink hover:bg-muted"
          aria-label={`查看 ${entry.name} 的回答`}
        >
          查看
        </Link>
      ) : null}
    </li>
  )
}

// ── 右欄：收件進度、欄位 ───────────────────────────────────────────────────────

/** 收件進度環：只用系網橘一個主軸色；分母 0 時不畫比例、顯示「—」。 */
function Ring({ percent }: { percent: number | null }) {
  const r = 36
  const c = 2 * Math.PI * r
  const shown = percent ?? 0
  return (
    <svg viewBox="0 0 88 88" className="size-[5.5rem] shrink-0" role="img" aria-label={percent === null ? '沒有應交的人' : `完成 ${percent}%`}>
      <circle cx="44" cy="44" r={r} fill="none" stroke="var(--color-muted)" strokeWidth="9" />
      <circle
        cx="44"
        cy="44"
        r={r}
        fill="none"
        stroke="var(--color-primary)"
        strokeWidth="9"
        strokeLinecap="round"
        strokeDasharray={`${(shown / 100) * c} ${c}`}
        transform="rotate(-90 44 44)"
      />
      <text x="44" y="49" textAnchor="middle" className="fill-ink text-[15px] font-bold tabular-nums">
        {percent === null ? '—' : `${percent}%`}
      </text>
    </svg>
  )
}

export function CompletionPanel({ completion, individual }: { completion: Completion; individual: boolean }) {
  if (!individual) {
    return (
      <section aria-labelledby="progress-title" className="rounded-card border border-border bg-background p-5">
        <h2 id="progress-title" className="text-base font-semibold text-ink">
          收件進度
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          整組一份：名單上有 {completion.required} 組應交。組別繳交與組別完成率會在組別繳交上線後顯示。
        </p>
      </section>
    )
  }
  const rows: [string, number, string?][] = [
    ['已正式送出', completion.done],
    ['未繳（還沒截止）', completion.pending],
    ['逾期未繳', completion.overdue, completion.overdue > 0 ? 'text-danger-on-subtle' : undefined],
  ]
  return (
    <section aria-labelledby="progress-title" className="rounded-card border border-border bg-background p-5" data-testid="completion">
      <h2 id="progress-title" className="text-base font-semibold text-ink">
        收件進度
      </h2>
      <div className="mt-3 flex items-center gap-5">
        <Ring percent={completion.percent} />
        <div className="min-w-0 flex-1">
          <p className="text-2xl font-semibold text-ink tabular-nums" data-testid="completion-rate">
            {completion.done}／{completion.required}
          </p>
          <p className="text-xs text-muted-foreground">已正式送出／應交人數</p>
        </div>
      </div>
      <dl className="mt-4 grid gap-1.5 text-sm">
        {rows.map(([label, value, tone]) => (
          <div key={label} className="flex justify-between">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className={cn('font-semibold tabular-nums', tone)}>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground tabular-nums">
        不計入：免填 {completion.exempt} 人・已移出 {completion.removed} 人
      </p>
    </section>
  )
}

export function FieldsPanel({ fields, schemaVersionNo }: { fields: readonly FormField[]; schemaVersionNo: number | null }) {
  const inputs = answerFields(fields)
  return (
    <section aria-labelledby="fields-title" className="rounded-card border border-border bg-background p-5">
      <h2 id="fields-title" className="text-base font-semibold text-ink">
        欄位
        <span className="ml-2 text-xs font-normal text-muted-foreground tabular-nums">
          {inputs.length} 個{schemaVersionNo ? `・版本 ${schemaVersionNo}` : ''}
        </span>
      </h2>
      {inputs.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">還沒有發布中的欄位。</p>
      ) : (
        <ul className="mt-2 text-sm">
          {inputs.map((f) => (
            <li key={f.key} className="flex items-center justify-between gap-2 py-1">
              <span className="truncate">{f.label}</span>
              {f.required ? <span className="shrink-0 text-[11px] font-semibold text-primary-on-subtle">必填</span> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// ── 點一個人 ──────────────────────────────────────────────────────────────────

export function ReceiverView({
  base,
  detail,
  window,
  businessNow,
}: {
  base: string
  detail: ReceiverDetail
  window: ItemWindow
  businessNow: Date
}) {
  const { entry } = detail
  const category = categoryOf(entry)
  const status = receiverStatus(window, entry, businessNow)
  const back = category === 'current' ? base : `${base}?list=${category}`
  const banner =
    category === 'removed'
      ? `已移出（${entry.removedReason ?? ''}）・回答保留`
      : category === 'exempt'
        ? `免填・理由：${entry.exemptReason ?? ''}`
        : status.headline
  return (
    <article className="rounded-card border border-border bg-background" data-testid="receiver-view">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 pt-4">
        <Link href={back} className="text-sm font-medium text-muted-foreground hover:text-ink">
          ← {category === 'current' ? '收件名單' : category === 'exempt' ? '免填' : '已移出'}
        </Link>
      </div>
      <header className="px-5 pb-3 pt-2">
        <h2 className="text-lg font-semibold text-ink">
          {entry.name}
          <span className="ml-2 text-sm font-normal text-muted-foreground tabular-nums">
            {entry.studentNo ?? ''}
            {entry.groupCode ? `・${entry.groupCode}` : ''}
          </span>
        </h2>
        <p className="mt-1 text-sm font-semibold text-primary-on-subtle" data-testid="receiver-status">
          {banner}
        </p>
      </header>

      <section aria-labelledby="versions-title" className="border-t border-border px-5 py-4">
        <h3 id="versions-title" className="text-sm font-semibold text-ink">
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
                    收件時間（臺灣時間）
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    送出者
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    欄位版本
                  </th>
                  <th scope="col" className="py-2">
                    <span className="sr-only">動作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {detail.versions.map((v, index) => (
                  <tr key={v.versionNo} className="border-t border-border">
                    <td className="py-3 font-semibold tabular-nums">
                      第 {v.versionNo} 次
                      {index === 0 ? (
                        <span className="ml-2 rounded-full bg-primary-subtle px-2 py-0.5 text-[11px] text-primary-on-subtle">採計</span>
                      ) : null}
                    </td>
                    <td className="py-3 tabular-nums">{formatTaipeiSecond(v.receivedBusinessAt)}</td>
                    <td className="py-3">{v.submittedByName}</td>
                    <td className="py-3 tabular-nums">v{v.schemaVersionNo}</td>
                    <td className="py-1 text-right">
                      <Link
                        href={`${base}?person=${entry.receiverId}&version=${v.versionNo}`}
                        className="inline-flex h-10 items-center rounded-md px-3 text-sm font-semibold text-primary-on-subtle hover:bg-muted"
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
            ? `另有一份草稿（最後儲存 ${formatTaipeiMinute(detail.draftUpdatedAt)}）。草稿只有本人看得到；這裡只列正式送出的版本。`
            : '沒有草稿。'}
        </p>
      </section>

      <section aria-labelledby="spans-title" className="border-t border-border px-5 py-4">
        <h3 id="spans-title" className="text-sm font-semibold text-ink">
          名單紀錄
        </h3>
        <ul className="mt-2 space-y-1.5 text-sm">
          {detail.spans.map((s, index) => (
            <li key={index} className="tabular-nums">
              {formatTaipeiMinute(s.eligibleFrom)} {s.source === 'admin' ? '管理員加入' : '自動加入'}
              {s.exempt ? `・免填（${s.exemptReason ?? ''}）` : ''}
              {s.eligibleTo ? `・${formatTaipeiMinute(s.eligibleTo)} 移出（${s.removedReason ?? ''}）` : '・目前在名單上'}
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
    ['收件時間', formatTaipeiSecond(version.receivedBusinessAt)],
    ['送出者', version.submittedByName],
    ['欄位版本', `v${version.schemaVersionNo}`],
    ['回執編號', version.requestId],
  ]
  return (
    <article className="space-y-4 rounded-card border border-border bg-background p-5" data-testid="version-view">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Link href={`${base}?person=${detail.entry.receiverId}`} className="text-sm font-medium text-muted-foreground hover:text-ink">
          ← {detail.entry.name} 的版本
        </Link>
        <span className="text-xs text-muted-foreground">唯讀・這是第 {version.versionNo} 次送出當時的內容</span>
      </div>
      <h2 className="text-lg font-semibold text-ink">
        {detail.entry.name}・第 {version.versionNo} 次
        {version.isLatest ? (
          <span className="ml-2 rounded-full bg-primary-subtle px-2 py-0.5 text-xs text-primary-on-subtle">採計</span>
        ) : (
          <span className="ml-2 text-sm font-normal text-muted-foreground">已被後來的版本取代</span>
        )}
      </h2>
      <dl className="grid gap-x-8 gap-y-2 border-y border-border py-3 text-sm sm:grid-cols-2">
        {facts.map(([k, v]) => (
          <div key={k} className="flex gap-4">
            <dt className="w-16 shrink-0 text-muted-foreground">{k}</dt>
            <dd className={cn('font-semibold tabular-nums', k === '回執編號' && 'break-all font-mono text-xs font-normal')}>{v}</dd>
          </div>
        ))}
      </dl>
      <dl className="divide-y divide-border">
        {fields.map((f) => {
          const value = version.answers[f.key]
          const text = value === undefined ? '' : typeof value === 'string' ? value : value.join('、')
          return (
            <div key={f.key} className="grid gap-1 py-3 sm:grid-cols-[12rem_1fr] sm:gap-6">
              <dt className="text-sm font-semibold">{f.label}</dt>
              <dd className="whitespace-pre-wrap text-sm">{text || <span className="text-muted-foreground">（未填）</span>}</dd>
            </div>
          )
        })}
      </dl>
    </article>
  )
}
