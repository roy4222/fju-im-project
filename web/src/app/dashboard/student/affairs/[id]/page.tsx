import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { STUDENT_NAV } from '@/app/dashboard/_nav'
import { SubmissionForm } from '@/app/dashboard/student/affairs/[id]/submission-form'
import { BANNER_CLASS } from '@/app/dashboard/student/affairs/tone'
import type { FileMeta } from '@/app/dashboard/student/affairs/types'
import type { AnswerFile, Answers, GroupSummary, MyItemDetail, MyVersionDetail } from '@/application/submissions'
import { getBusinessClock } from '@/composition/cohorts'
import { renderBodyHtml } from '@/composition/items'
import { answerFields, getSubmissionQuery, isFileField, phaseOf, statusOf } from '@/composition/submissions'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute, formatTaipeiSecond } from '@/shared/time'

export const metadata = { title: '作業內容｜資管系專題平台' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  return `${Math.max(1, Math.round(bytes / 1024))} KiB`
}

/**
 * 學生作業內容頁（票 17 個人版；票 21 組別版：原型 `/dashboard/student/affairs/[id]` 的共用表單、上傳進度、收件章回執）：
 * 「作業內容」與「繳交歷史」兩個分頁。
 *
 * 只有自己（整組一份：自己此刻所在的組）在目前收件名單上才看得到（不在名單上一律 404，不透露這份收件存在）。
 * 內容頁：組別資訊（整組一份）→ 截止、階段、附件、重送規則 → 作業說明 → 欄位（上傳、儲存草稿、正式送出、收件章回執）。
 * 繳交歷史：每一次正式送出（第幾次、送出者、時間、回執編號），點進去看那一次的內容與附件（唯讀）。
 */
export default async function StudentAffairPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string | string[]; version?: string | string[] }>
}) {
  const { id } = await params
  const actor = await requireRole(`/dashboard/student/affairs${UUID.test(id) ? `/${id}` : ''}`, 'student')
  if (!UUID.test(id)) notFound()
  const userId = actor.kind === 'authenticated' ? actor.userId : ''
  const search = await searchParams
  const tab = search.tab === 'history' ? 'history' : 'content'
  const versionNo = Number(typeof search.version === 'string' ? search.version : NaN)

  const query = getSubmissionQuery()
  const [item, businessNow] = await Promise.all([query.myItem(userId, id), getBusinessClock().now()])
  if (!item) notFound()
  const version = tab === 'history' && Number.isInteger(versionNo) && versionNo > 0 ? await query.myVersion(userId, id, versionNo) : null

  const phase = phaseOf({ opensAt: item.opensAt, dueAt: item.dueAt }, businessNow)
  const latest = item.versions[0] ?? null
  const status = statusOf({
    phase,
    opensAt: item.opensAt,
    latestVersionNo: latest?.versionNo ?? null,
    hasDraft: item.draft !== null,
    exempt: item.exempt,
  })
  const banner = latest
    ? `已繳 v${latest.versionNo}・${latest.submittedByName} 於 ${formatTaipeiSecond(latest.receivedBusinessAt)} 送出・${status.detail}`
    : `${status.headline}・${status.detail}`
  const lockedText = item.exempt
    ? '系辦已將你設為免填這份收件，不需要填寫。'
    : phase === 'not_open'
      ? `還沒開放：${item.opensAt ? formatTaipeiMinute(item.opensAt) : ''}（臺灣時間）開放後才能填寫與送出。`
      : phase === 'closed'
        ? '已截止・唯讀；需要補交請聯絡系辦重新開放。'
        : null
  // 截止後、尚未開放：欄位顯示草稿（沒有草稿就顯示最後一次送出的內容）。
  const latestVersion = !item.draft && latest ? await query.myVersion(userId, id, latest.versionNo) : null
  const shown: Answers = item.draft?.answers ?? latestVersion?.answers ?? {}
  const shownFiles: readonly AnswerFile[] = item.draft?.files ?? latestVersion?.files ?? []
  const group = item.group

  const info: [string, string][] = [
    ['截止時間', item.dueAt ? `${formatTaipeiMinute(item.dueAt)}（含此分鐘）` : '無'],
    ['開放時間', item.opensAt ? formatTaipeiMinute(item.opensAt) : '發布即開放'],
    ['階段', item.stageName ?? '未指定'],
    ['重送', phase === 'closed' ? '截止後唯讀' : '截止前可重送，以最後一次為準'],
  ]

  return (
    <DashboardShell roleLabel="學生" items={STUDENT_NAV} current="/dashboard/student/affairs">
      <Link href="/dashboard/student/affairs" className="mb-4 inline-flex text-sm font-medium text-muted-foreground hover:text-ink">
        ← 作業區
      </Link>
      <article className="overflow-hidden rounded-card border border-border bg-background">
        <header className="px-5 pb-3 pt-5">
          <h1 className="text-xl font-bold text-ink">{item.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {group ? '整組一份・同組共用一份草稿，任一位組員正式送出就代表全組' : '個人一份・每位同學各自填寫'}
          </p>
          {group ? <GroupBar group={group} /> : null}
        </header>
        <p className={cn('mx-5 mb-4 rounded-md px-4 py-3 text-sm font-semibold', BANNER_CLASS[status.tone])} data-testid="affair-banner">
          {banner}
        </p>
        <nav className="flex gap-1 border-b border-border px-3" aria-label="作業分頁">
          {(
            [
              ['content', '作業內容'],
              ['history', `繳交歷史${item.versions.length ? `（${item.versions.length}）` : ''}`],
            ] as const
          ).map(([key, label]) => (
            <Link
              key={key}
              href={`/dashboard/student/affairs/${item.itemId}${key === 'history' ? '?tab=history' : ''}`}
              aria-current={tab === key ? 'page' : undefined}
              className={cn(
                '-mb-px inline-flex h-11 items-center border-b-2 px-4 text-sm font-semibold',
                tab === key ? 'border-primary text-ink' : 'border-transparent text-muted-foreground hover:text-ink',
              )}
            >
              {label}
            </Link>
          ))}
        </nav>

        {tab === 'content' ? (
          <div className="space-y-6 p-5">
            <dl className="grid gap-x-8 gap-y-2 border-b border-border pb-4 text-sm sm:grid-cols-2">
              {info.map(([k, v]) => (
                <div key={k} className="flex gap-4">
                  <dt className="w-16 shrink-0 text-muted-foreground">{k}</dt>
                  <dd className="font-semibold tabular-nums">{v}</dd>
                </div>
              ))}
            </dl>
            <section aria-labelledby="sec-brief">
              <h2 id="sec-brief" className="mb-2 text-base font-semibold text-ink">
                作業說明
              </h2>
              {item.summary ? <p className="mb-2 text-sm text-muted-foreground">{item.summary}</p> : null}
              {item.bodyHtml ? (
                <div className="prose-item space-y-2 text-sm leading-7" dangerouslySetInnerHTML={{ __html: renderBodyHtml(item.bodyHtml) }} />
              ) : null}
              {item.attachments.length > 0 ? (
                <ul className="mt-3 space-y-1.5">
                  {item.attachments.map((file) => (
                    <li key={file.fileId}>
                      <a href={`/api/files/${file.fileId}`} className="text-sm font-semibold text-primary-on-subtle underline-offset-2 hover:underline">
                        {file.name}
                      </a>
                      <span className="ml-2 text-xs text-muted-foreground">{formatSize(file.sizeBytes)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
            <section aria-labelledby="sec-fill">
              <h2 id="sec-fill" className="mb-3 text-base font-semibold text-ink">
                {status.editable ? (latest ? '重送' : '填寫與繳交') : '填寫內容（唯讀）'}
              </h2>
              {item.advisorCanView ? (
                <p className="mb-3 rounded-md bg-muted px-3 py-2 text-sm text-ink" data-testid="advisor-notice">
                  你的主指導老師可以查看這份收件<strong>正式送出</strong>的回答（草稿不會給老師看）。
                </p>
              ) : null}
              {group && item.draft?.updatedByName ? (
                <p className="mb-3 text-xs text-muted-foreground" data-testid="draft-updated-by">
                  共用草稿最後由 {item.draft.updatedByName} 於 {formatTaipeiMinute(item.draft.updatedAt)} 儲存
                </p>
              ) : null}
              <SubmissionForm
                itemId={item.itemId}
                fields={item.fields}
                initialAnswers={toValues(shown)}
                initialFiles={toFileMeta(shownFiles)}
                initialRevision={item.draft?.revision ?? 0}
                initialSavedText={item.draft ? formatTaipeiMinute(item.draft.updatedAt) : null}
                editable={status.editable}
                lockedText={lockedText}
                submittedVersion={latest?.versionNo ?? null}
                groupCode={group?.code ?? null}
              />
            </section>
          </div>
        ) : version ? (
          <VersionView item={item} version={version} />
        ) : (
          <History item={item} />
        )}
      </article>
    </DashboardShell>
  )
}

function toValues(answers: Answers): Record<string, string | string[]> {
  return Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, typeof v === 'string' ? v : [...v]]))
}

function toFileMeta(files: readonly AnswerFile[]): Record<string, FileMeta> {
  return Object.fromEntries(files.map((f) => [f.fileId, { name: f.name, sizeBytes: f.sizeBytes }]))
}

/** 組別資訊列（原型 `groupinfo`）：組別代號、組長、組員、指導老師。 */
function GroupBar({ group }: { group: GroupSummary }) {
  const leader = group.members.find((m) => m.isLeader)
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-border pt-3 text-sm" data-testid="group-bar">
      <span className="font-semibold text-ink">{group.code}</span>
      {leader ? <span>組長 {leader.name}</span> : null}
      <span className="text-muted-foreground">{group.members.map((m) => m.name).join('、')}</span>
      <span className="text-muted-foreground">指導老師 {group.advisorName ?? '尚未指派'}</span>
    </div>
  )
}

function History({ item }: { item: MyItemDetail }) {
  if (item.versions.length === 0) {
    return <p className="px-5 py-10 text-center text-sm text-muted-foreground">還沒有正式送出過。</p>
  }
  return (
    <div className="overflow-x-auto p-5">
      <table className="w-full min-w-[36rem] text-sm" aria-label="繳交歷史">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="py-2 font-medium">
              第幾次
            </th>
            <th scope="col" className="py-2 font-medium">
              送出者
            </th>
            <th scope="col" className="py-2 font-medium">
              收件時間（臺灣時間）
            </th>
            <th scope="col" className="py-2 font-medium">
              回執編號
            </th>
            <th scope="col" className="py-2">
              <span className="sr-only">動作</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {item.versions.map((v, index) => (
            <tr key={v.versionNo} className="border-t border-border">
              <td className="py-3 font-semibold tabular-nums">
                第 {v.versionNo} 次
                {index === 0 ? (
                  <span className="ml-2 rounded-full bg-primary-subtle px-2 py-0.5 text-[11px] text-primary-on-subtle">採計</span>
                ) : null}
              </td>
              <td className="py-3">{v.submittedByName}</td>
              <td className="py-3 tabular-nums">{formatTaipeiSecond(v.receivedBusinessAt)}</td>
              <td className="py-3 font-mono text-xs text-muted-foreground">{v.requestId}</td>
              <td className="py-1 text-right">
                <Link
                  href={`/dashboard/student/affairs/${item.itemId}?tab=history&version=${v.versionNo}`}
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

function VersionView({ item, version }: { item: MyItemDetail; version: MyVersionDetail }) {
  const fields = answerFields(version.fields)
  return (
    <div className="space-y-5 p-5" data-testid="version-view">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Link
          href={`/dashboard/student/affairs/${item.itemId}?tab=history`}
          className="text-sm font-medium text-muted-foreground hover:text-ink"
        >
          ← 繳交歷史
        </Link>
        <span className="text-xs text-muted-foreground">唯讀・這是第 {version.versionNo} 次送出當時的內容</span>
      </div>
      <dl className="grid gap-x-8 gap-y-2 border-y border-border py-3 text-sm sm:grid-cols-2">
        <div className="flex gap-4">
          <dt className="w-16 shrink-0 text-muted-foreground">版本</dt>
          <dd className="font-semibold tabular-nums">
            第 {version.versionNo} 次
            {version.isLatest ? (
              <span className="ml-2 rounded-full bg-primary-subtle px-2 py-0.5 text-[11px] text-primary-on-subtle">採計</span>
            ) : (
              <span className="ml-2 text-xs font-normal text-muted-foreground">已被後來的版本取代</span>
            )}
          </dd>
        </div>
        <div className="flex gap-4">
          <dt className="w-16 shrink-0 text-muted-foreground">送出者</dt>
          <dd className="font-semibold">{version.submittedByName}</dd>
        </div>
        <div className="flex gap-4">
          <dt className="w-16 shrink-0 text-muted-foreground">收件時間</dt>
          <dd className="font-semibold tabular-nums">{formatTaipeiSecond(version.receivedBusinessAt)}</dd>
        </div>
        <div className="flex gap-4">
          <dt className="w-16 shrink-0 text-muted-foreground">欄位版本</dt>
          <dd className="tabular-nums">v{version.schemaVersionNo}</dd>
        </div>
        <div className="flex gap-4 sm:col-span-2">
          <dt className="w-16 shrink-0 text-muted-foreground">回執編號</dt>
          <dd className="break-all font-mono text-xs">{version.requestId}</dd>
        </div>
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
                    <span className="text-xs text-muted-foreground tabular-nums">{formatSize(file.sizeBytes)}</span>
                    <span className="font-mono text-[11px] text-muted-foreground" title={file.checksum}>
                      sha256 {file.checksum.slice(0, 12)}…
                    </span>
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
