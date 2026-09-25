import { notFound } from 'next/navigation'
import { IconClock, IconFileText, IconHistory } from '@tabler/icons-react'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { TEACHER_NAV } from '@/app/dashboard/_nav'
import { VersionContent, VersionTable } from '@/app/dashboard/_submissions/version-parts'
import { BackLink, PageTitle, Panel, Pill, Ring, SegmentBar, type PillTone } from '@/app/dashboard/teacher/_ui/dash'
import { EntryList, type EntryView } from '@/app/dashboard/teacher/affairs/[id]/entry-list'
import type { ItemWindow, RosterEntry, StatusTone } from '@/application/submissions'
import { getBusinessClock } from '@/composition/cohorts'
import { RECEIVER_UNIT_LABEL } from '@/composition/items'
import { answerFields, categoryOf, completionOf, getAdvisorSubmissionQuery, receiverStatus } from '@/composition/submissions'
import { formatTaipeiMinute } from '@/shared/time'

export const metadata = { title: '收件狀態｜資管系專題平台' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TONE: Record<StatusTone, PillTone> = { success: 'success', brand: 'brand', muted: 'default', info: 'info', danger: 'danger' }
const DAY_MS = 24 * 60 * 60 * 1000

function one(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * 老師看某一份收件（票 22；票 37 照原型 `/dashboard/teacher/affairs/[id]`：左邊我的指導組別、右邊收件進度與欄位）。
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
  const dueTone: PillTone = !item.dueAt ? 'default' : item.dueAt <= businessNow ? 'danger' : item.dueAt.getTime() - businessNow.getTime() <= 10 * DAY_MS ? 'brand' : 'default'

  const shell = (back: { href: string; label: string }, children: React.ReactNode) => (
    <DashboardShell roleLabel="老師" items={TEACHER_NAV} current="/dashboard/teacher/affairs">
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-3">
          <BackLink href={back.href}>{back.label}</BackLink>
          <PageTitle
            eyebrow={`${item.cohortCode}・${RECEIVER_UNIT_LABEL[item.receiverUnit]}${item.stageName ? `・${item.stageName}` : ''}`}
            title={item.title}
            description={
              individual
                ? `只列你指導的學生、欄位第 ${view.effectiveFromVersionNo ?? 1} 版起正式送出的回答；草稿不給老師看。`
                : '只列你此刻指導的組別；這裡只有正式送出的版本，共用草稿不給老師看。'
            }
            actions={
              <>
                <Pill tone={dueTone}>
                  <IconClock className="mr-1 size-3" />
                  {item.dueAt ? `${formatTaipeiMinute(item.dueAt)} 截止（含此分鐘）` : '沒有截止'}
                </Pill>
                {item.schemaVersionNo ? <Pill>欄位 v{item.schemaVersionNo}</Pill> : null}
                {view.effectiveFromVersionNo ? <Pill>主指導閱覽自欄位第 {view.effectiveFromVersionNo} 版起</Pill> : null}
              </>
            }
          />
        </div>
        {children}
      </div>
    </DashboardShell>
  )

  if (receiverId) {
    if (!UUID.test(receiverId)) notFound()
    const receiver = await query.receiver(actor, item.itemId, receiverId)
    if (!receiver) notFound()
    const receiverBase = `${base}?${param}=${receiverId}`
    const who = individual ? receiver.entry.name : `${receiver.entry.name} 組`
    if (versionText !== undefined) {
      const version = await query.receiverVersion(actor, item.itemId, receiverId, Number(versionText))
      if (!version) notFound()
      return shell(
        { href: base, label: individual ? '我指導的學生' : '我的指導組別' },
        <section aria-label={`${who}第 ${version.versionNo} 次送出`} className="dash-card p-5">
          <VersionContent version={version} backHref={receiverBase} backLabel={`${who}的版本`} title={who} />
        </section>,
      )
    }
    const status = entryStatus(item, receiver.entry, businessNow)
    return shell(
      { href: base, label: individual ? '我指導的學生' : '我的指導組別' },
      <Panel
        title={who}
        icon={<IconHistory />}
        description={individual && receiver.entry.studentNo ? `${receiver.entry.studentNo}${receiver.entry.groupCode ? `・${receiver.entry.groupCode}` : ''}` : undefined}
        testId="receiver-view"
        action={<Pill tone={status.tone} testId="receiver-status">{status.headline}</Pill>}
      >
        <div className="border-t border-border px-5 py-4">
          <h3 className="text-sm font-bold text-foreground">正式送出的版本（{receiver.versions.length}）</h3>
          <VersionTable versions={receiver.versions} hrefOf={(no) => `${receiverBase}&version=${no}`} />
          <p className="mt-3 text-xs text-muted-foreground">
            {individual
              ? `只列欄位第 ${view.effectiveFromVersionNo ?? 1} 版起正式送出的回答；草稿不給老師看。`
              : '這裡只列正式送出的版本，跟組員、系辦看到的是同一份；共用草稿不給老師看。'}
          </p>
        </div>
      </Panel>,
    )
  }

  const completion = completionOf(item, view.entries, businessNow)
  const unit = individual ? '位' : '組'
  const entries: EntryView[] = view.entries.map((entry) => {
    const status = entryStatus(item, entry, businessNow)
    return {
      receiverId: entry.receiverId,
      label: individual ? (entry.studentNo ?? '') : '',
      sub: individual ? `${entry.name}${entry.groupCode ? `・${entry.groupCode}` : ''}` : `${entry.name} 組`,
      headline: status.headline,
      tone: status.tone,
      detail: status.detail,
      href: `${base}?${param}=${entry.receiverId}`,
      ariaLabel: individual ? `查看 ${entry.name} 的繳交` : `查看 ${entry.name} 組的繳交`,
      missing: status.missing,
      overdue: status.overdue,
    }
  })
  const fields = answerFields(item.fields)

  return shell(
    { href: '/dashboard/teacher/affairs', label: '各組繳交狀態' },
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <EntryList
        title={individual ? '我指導的學生' : '我的指導組別'}
        unit={unit}
        entries={entries}
        emptyText={individual ? '你指導的組裡沒有人在這份收件的名單上。' : '你指導的組都不在這份收件的名單上。'}
      />
      <div className="flex flex-col gap-5">
        <Panel title="收件進度" icon={<IconFileText />} description={`應交 ${completion.required} ${unit}`} testId="completion">
          <div className="flex items-center gap-5 px-5 py-4">
            <Ring
              value={completion.percent}
              size={84}
              stroke={9}
              color="var(--success)"
              label={completion.percent === null ? '沒有應交的人' : `完成 ${completion.percent}%`}
            >
              <span className="tabular text-base font-extrabold text-foreground">{completion.percent === null ? '—' : `${completion.percent}%`}</span>
            </Ring>
            <dl className="grid flex-1 grid-cols-1 gap-1.5 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">已正式送出</dt>
                <dd className="tabular font-semibold" data-testid="completion-rate">
                  {completion.done}／{completion.required}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">逾期未繳</dt>
                <dd className="tabular font-semibold text-destructive">{completion.overdue}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">未繳（還沒截止）</dt>
                <dd className="tabular font-semibold">{completion.pending}</dd>
              </div>
            </dl>
          </div>
          <div className="px-5 pb-3">
            <SegmentBar
              segments={[
                { value: completion.done, color: 'var(--success)', label: '已正式送出' },
                { value: completion.overdue, color: 'var(--destructive)', label: '逾期未繳' },
                { value: completion.pending, color: 'var(--muted)', label: '未繳' },
              ]}
            />
          </div>
          <p className="tabular border-t border-border px-5 py-2.5 text-xs text-muted-foreground">
            不計入：免填 {completion.exempt} {unit}・已移出 {completion.removed} {unit}
          </p>
        </Panel>
        <Panel title="欄位" icon={<IconFileText />} description={`${fields.length} 個・版本 ${item.schemaVersionNo ?? 1}`}>
          <ul className="flex flex-col gap-1 px-5 pb-3 text-sm">
            {fields.map((f) => (
              <li key={f.key} className="flex items-center justify-between gap-2 py-1">
                <span className="truncate">{f.label}</span>
                {f.required ? <span className="shrink-0 text-[11px] text-destructive">必填</span> : null}
              </li>
            ))}
            {fields.length === 0 ? <li className="py-1 text-muted-foreground">這份收件沒有要填的欄位。</li> : null}
          </ul>
        </Panel>
      </div>
    </div>,
  )
}

/** 老師看到的一列狀態：跟學生作業區、系辦名單頁同一個 `receiverStatus`（草稿一律當沒有）。 */
function entryStatus(
  window: ItemWindow,
  entry: RosterEntry,
  businessNow: Date,
): { headline: string; tone: PillTone; detail: string; missing: boolean; overdue: boolean } {
  const category = categoryOf(entry)
  if (category === 'removed') {
    return {
      headline: '已移出名單',
      tone: 'default',
      detail: `${entry.eligibleTo ? formatTaipeiMinute(entry.eligibleTo) : ''}・${entry.removedReason ?? ''}`,
      missing: false,
      overdue: false,
    }
  }
  if (category === 'exempt') return { headline: '免填', tone: 'default', detail: `理由：${entry.exemptReason ?? ''}`, missing: false, overdue: false }
  const status = receiverStatus(window, { exempt: false, hasDraft: false, latestVersionNo: entry.latestVersionNo }, businessNow)
  const detail =
    entry.latestVersionNo !== null && entry.latestReceivedAt
      ? `v${entry.latestVersionNo}・${entry.latestSubmittedByName ?? ''}・${formatTaipeiMinute(entry.latestReceivedAt).slice(5)}`
      : status.overdue
        ? '已截止，沒有正式送出'
        : status.headline === '尚未開放'
          ? status.detail
          : '還沒正式送出'
  return { headline: status.headline, tone: TONE[status.tone], detail, missing: entry.latestVersionNo === null, overdue: status.overdue }
}
