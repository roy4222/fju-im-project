import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { TEACHER_NAV } from '@/app/dashboard/_nav'
import { CompletionPanel } from '@/app/dashboard/_submissions/completion-panel'
import { VersionContent, VersionTable } from '@/app/dashboard/_submissions/version-parts'
import { TONE_CLASS } from '@/app/dashboard/student/affairs/tone'
import type { ItemWindow, RosterEntry } from '@/application/submissions'
import { getBusinessClock } from '@/composition/cohorts'
import { RECEIVER_UNIT_LABEL } from '@/composition/items'
import { categoryOf, completionOf, getAdvisorSubmissionQuery, receiverStatus } from '@/composition/submissions'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute } from '@/shared/time'

export const metadata = { title: '收件狀態｜資管系專題平台' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function one(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * 老師看某一份收件（票 22；原型 `/dashboard/teacher/affairs/[id]`「該項目我的各組狀態與版本」）。
 *
 * - 整組一份：只列自己**此刻**指導的組；點一組（`?group=`）看它每一次正式送出，再點（`&version=`）看那一次的內容與附件。
 * - 個人一份：系辦開了主指導閱覽才看得到，只列自己指導的組裡的學生（`?person=`），只算開放那一版欄位以後的正式送出。
 * - 草稿一律不給老師（連有沒有草稿都不透露）。換掉的老師、別組的老師直接打網址一律 404（查詢自己再判一次授權）。
 * - 版本列表與內容跟組員、系辦看到的是同一段查詢；附件每次下載都重新授權。
 */
export default async function TeacherAffairPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ group?: string | string[]; person?: string | string[]; version?: string | string[] }>
}) {
  const { id } = await params
  const actor = await requireRole(`/dashboard/teacher/affairs${UUID.test(id) ? `/${id}` : ''}`, 'teacher')
  if (!UUID.test(id)) notFound()
  const search = await searchParams
  const receiverId = one(search.group) ?? one(search.person)
  const versionText = one(search.version)

  const query = getAdvisorSubmissionQuery()
  const [view, businessNow] = await Promise.all([query.item(actor, id), getBusinessClock().now()])
  if (!view) notFound()
  const { item } = view
  const individual = item.receiverUnit === 'individual'
  const base = `/dashboard/teacher/affairs/${item.itemId}`
  const param = individual ? 'person' : 'group'

  const shell = (children: React.ReactNode) => (
    <DashboardShell roleLabel="老師" items={TEACHER_NAV} current="/dashboard/teacher/affairs">
      <Link href="/dashboard/teacher/affairs" className="mb-4 inline-flex text-sm font-medium text-muted-foreground hover:text-ink">
        ← 各組繳交狀態
      </Link>
      <header className="mb-5">
        <p className="text-xs font-semibold text-primary">
          {item.cohortCode}・{RECEIVER_UNIT_LABEL[item.receiverUnit]}
          {item.stageName ? `・${item.stageName}` : ''}
        </p>
        <h1 className="mt-0.5 text-xl font-semibold text-ink">{item.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground tabular-nums">
          {item.dueAt ? `${formatTaipeiMinute(item.dueAt)} 截止（含此分鐘）` : '沒有截止'}
          {item.schemaVersionNo ? `・欄位 v${item.schemaVersionNo}` : ''}
          {view.effectiveFromVersionNo ? `・主指導閱覽自欄位第 ${view.effectiveFromVersionNo} 版起` : ''}
        </p>
      </header>
      {children}
    </DashboardShell>
  )

  if (receiverId) {
    if (!UUID.test(receiverId)) notFound()
    const receiver = await query.receiver(actor, item.itemId, receiverId)
    if (!receiver) notFound()
    const receiverBase = `${base}?${param}=${receiverId}`
    if (versionText !== undefined) {
      const version = await query.receiverVersion(actor, item.itemId, receiverId, Number(versionText))
      if (!version) notFound()
      return shell(
        <article className="rounded-card border border-border bg-background p-5">
          <VersionContent
            version={version}
            backHref={receiverBase}
            backLabel={`${individual ? receiver.entry.name : `${receiver.entry.name} 組`}的版本`}
            title={individual ? receiver.entry.name : `${receiver.entry.name} 組`}
          />
        </article>,
      )
    }
    const status = entryStatus(item, receiver.entry, businessNow)
    return shell(
      <article className="rounded-card border border-border bg-background" data-testid="receiver-view">
        <div className="px-5 pt-4">
          <Link href={base} className="text-sm font-medium text-muted-foreground hover:text-ink">
            ← {individual ? '我指導的學生' : '我的指導組別'}
          </Link>
        </div>
        <header className="px-5 pb-3 pt-2">
          <h2 className="text-lg font-semibold text-ink">
            {individual ? receiver.entry.name : `${receiver.entry.name} 組`}
            {individual && receiver.entry.studentNo ? (
              <span className="ml-2 text-sm font-normal text-muted-foreground tabular-nums">
                {receiver.entry.studentNo}
                {receiver.entry.groupCode ? `・${receiver.entry.groupCode}` : ''}
              </span>
            ) : null}
          </h2>
          <p className={cn('mt-1 text-sm font-semibold', status.tone)} data-testid="receiver-status">
            {status.headline}
          </p>
        </header>
        <section aria-labelledby="versions-title" className="border-t border-border px-5 py-4">
          <h3 id="versions-title" className="text-sm font-semibold text-ink">
            正式送出的版本（{receiver.versions.length}）
          </h3>
          <VersionTable versions={receiver.versions} hrefOf={(no) => `${receiverBase}&version=${no}`} />
          <p className="mt-3 text-xs text-muted-foreground">
            {individual
              ? `只列欄位第 ${view.effectiveFromVersionNo ?? 1} 版起正式送出的回答；草稿不給老師看。`
              : '這裡只列正式送出的版本，跟組員、系辦看到的是同一份；共用草稿不給老師看。'}
          </p>
        </section>
      </article>,
    )
  }

  const completion = completionOf(item, view.entries, businessNow)
  return shell(
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <section aria-labelledby="entries-title" className="rounded-card border border-border bg-background">
        <h2 id="entries-title" className="px-5 pt-4 text-base font-semibold text-ink">
          {individual ? '我指導的學生' : '我的指導組別'}
          <span className="ml-2 text-xs font-normal text-muted-foreground tabular-nums">{view.entries.length}</span>
        </h2>
        {view.entries.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-muted-foreground">
            {individual ? '你指導的組裡沒有人在這份收件的名單上。' : '你指導的組都不在這份收件的名單上。'}
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-border" aria-label={individual ? '我指導的學生' : '我的指導組別'}>
            {view.entries.map((entry) => {
              const status = entryStatus(item, entry, businessNow)
              const label = individual ? entry.name : `${entry.name} 組`
              return (
                <li key={entry.receiverId} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3" data-testid="teacher-entry">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-ink">{label}</span>
                    {individual ? (
                      <span className="block text-xs text-muted-foreground tabular-nums">
                        {entry.studentNo ?? ''}
                        {entry.groupCode ? `・${entry.groupCode}` : ''}
                      </span>
                    ) : null}
                  </span>
                  <span className="w-full sm:w-auto sm:min-w-[14rem]">
                    <span className={cn('block text-sm font-semibold', status.tone)}>{status.headline}</span>
                    <span className="block text-xs text-muted-foreground tabular-nums">{status.detail}</span>
                  </span>
                  <Link
                    href={`${base}?${param}=${entry.receiverId}`}
                    className="inline-flex h-10 shrink-0 items-center rounded-md border border-border px-3 text-sm font-medium text-ink hover:bg-muted"
                    aria-label={individual ? `查看 ${entry.name} 的繳交` : `查看 ${entry.name} 組的繳交`}
                  >
                    查看
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </section>
      <CompletionPanel completion={completion} individual={individual} />
    </div>,
  )
}

/** 老師看到的一列狀態：跟學生作業區、系辦名單頁同一個 `receiverStatus`（草稿一律當沒有）。 */
function entryStatus(window: ItemWindow, entry: RosterEntry, businessNow: Date): { headline: string; tone: string; detail: string } {
  const category = categoryOf(entry)
  if (category === 'removed') {
    return {
      headline: '已移出名單',
      tone: 'text-muted-foreground',
      detail: `${entry.eligibleTo ? formatTaipeiMinute(entry.eligibleTo) : ''}・${entry.removedReason ?? ''}`,
    }
  }
  if (category === 'exempt') return { headline: '免填', tone: 'text-muted-foreground', detail: `理由：${entry.exemptReason ?? ''}` }
  const status = receiverStatus(window, { exempt: false, hasDraft: false, latestVersionNo: entry.latestVersionNo }, businessNow)
  const detail =
    entry.latestVersionNo !== null && entry.latestReceivedAt
      ? `${entry.latestSubmittedByName ?? ''} 於 ${formatTaipeiMinute(entry.latestReceivedAt)} 送出`
      : status.overdue
        ? '已截止，沒有正式送出'
        : status.headline === '尚未開放'
          ? status.detail
          : '還沒正式送出'
  return { headline: status.headline, tone: TONE_CLASS[status.tone], detail }
}
