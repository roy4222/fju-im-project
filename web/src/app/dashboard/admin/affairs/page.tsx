import Link from 'next/link'
import { requireRole } from '@/app/_ui/guard'
import { DataTable, EmptyState, LinkButton, PageHeader } from '@/app/_ui/primitives'
import { DashboardShell } from '@/app/_ui/site-shell'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { QuickCreateDialog } from '@/app/dashboard/admin/affairs/quick-create-dialog'
import { editorVocabulary } from '@/app/dashboard/admin/affairs/vocabulary'
import { COHORT_STATUS_LABEL, getCohortStatusQuery } from '@/composition/cohorts'
import {
  AUDIENCE_LABEL,
  collectsResponses,
  getItemQuery,
  ITEM_STATUS_LABEL,
  PLACEMENT_LABEL,
  RECEIVER_UNIT_LABEL,
} from '@/composition/items'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute } from '@/shared/time'

export const metadata = { title: '專題事務｜資管系專題平台' }

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'news', label: '公告' },
  { key: 'resource', label: '資源' },
  { key: 'submission', label: '文件繳交' },
  { key: 'rules', label: '專題規則' },
] as const

/**
 * 專題事務工作台（票 15；原型 `/dashboard/admin/affairs`）。
 *
 * 公告、資源、文件繳交全部從這裡建立：日常用「新增項目」三步驟，要細調欄位、附件、封面再進完整編輯器
 * （同一個項目 ID）。編輯器不另放側欄入口（產品模組 04「單一入口」）。
 * 撤回、下架、重新發布在完整編輯器的頂列（票 16）；收件進度與名單頁在票 18。
 */
export default async function AffairsPage({
  searchParams,
}: {
  searchParams: Promise<{ cohort?: string | string[]; placement?: string | string[] }>
}) {
  await requireRole('/dashboard/admin/affairs', 'admin')

  const params = await searchParams
  const cohorts = (await getCohortStatusQuery().list()).filter((c) => c.status !== 'archived')
  const cohort = cohorts.find((c) => c.id === params.cohort) ?? cohorts.find((c) => c.isDefaultWorking) ?? cohorts[0] ?? null
  const filter = FILTERS.find((f) => f.key === params.placement)?.key ?? 'all'

  const shell = (children: React.ReactNode, actions?: React.ReactNode) => (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/affairs">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader title="專題事務" description="公告、資源下載、文件繳交都從這裡建立、發布與修改。" />
        {actions}
      </div>
      {children}
    </DashboardShell>
  )

  if (!cohort) {
    return shell(
      <EmptyState
        title="還沒有屆別"
        description="專題事務要綁在某一屆；先到屆別頁新增一屆。"
        action={{ href: '/dashboard/admin/cohorts', label: '前往屆別' }}
      />,
    )
  }

  const [rows, vocabulary] = await Promise.all([getItemQuery().list(cohort.id), editorVocabulary(cohort.id)])
  const shown = rows.filter((r) => filter === 'all' || r.placement === filter)
  const published = rows.filter((r) => r.status === 'published').length
  const collecting = rows.filter((r) => collectsResponses(r.placement) && r.status === 'published').length
  const query = (patch: Record<string, string>) => {
    const next = new URLSearchParams({ cohort: cohort.id, ...(filter !== 'all' ? { placement: filter } : {}), ...patch })
    if (next.get('placement') === 'all') next.delete('placement')
    return `/dashboard/admin/affairs?${next.toString()}`
  }

  return shell(
    <>
      {cohorts.length > 1 ? (
        <nav aria-label="選擇屆別" className="mb-4 flex flex-wrap gap-2">
          {cohorts.map((c) => (
            <Link
              key={c.id}
              href={`/dashboard/admin/affairs?cohort=${c.id}`}
              aria-current={c.id === cohort.id ? 'page' : undefined}
              className={cn(
                'rounded-full border px-3 py-1 text-sm',
                c.id === cohort.id ? 'border-primary bg-primary-subtle text-primary-on-subtle' : 'border-border text-ink hover:bg-muted',
              )}
            >
              {c.code}
            </Link>
          ))}
        </nav>
      ) : null}

      <section
        aria-label="專題事務摘要"
        className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-background px-5 py-4"
      >
        <div>
          <p className="text-xs font-semibold text-primary">
            {cohort.code}・{COHORT_STATUS_LABEL[cohort.status]}
          </p>
          <p className="mt-0.5 text-xl font-semibold text-ink tabular-nums">
            {rows.length} 項・發布中 {published}・收件中 {collecting}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <QuickCreateDialog cohortId={cohort.id} vocabulary={vocabulary} />
          <LinkButton href={`/dashboard/admin/editor/new?cohort=${cohort.id}`} variant="secondary">
            用完整編輯器建立
          </LinkButton>
        </div>
      </section>

      <nav aria-label="種類" className="mb-3 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={query({ placement: f.key })}
            aria-current={filter === f.key ? 'page' : undefined}
            className={cn(
              'rounded-full border px-3 py-1 text-sm',
              filter === f.key ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-ink hover:bg-muted',
            )}
          >
            {f.label}
          </Link>
        ))}
      </nav>

      <DataTable
        columns={['種類', '標題', '狀態', '對象', '截止／發布', '收件名單', '']}
        rows={shown.map((r) => [
          <span key="kind" className="text-muted-foreground">
            {PLACEMENT_LABEL[r.placement]}
          </span>,
          <Link key="title" href={`/dashboard/admin/editor/${r.id}`} className="font-medium text-ink hover:underline">
            {r.title}
          </Link>,
          <span
            key="status"
            className={cn(
              'whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold',
              r.status === 'published' ? 'bg-primary-subtle text-primary-on-subtle' : 'bg-muted text-muted-foreground',
            )}
          >
            {ITEM_STATUS_LABEL[r.status]}
          </span>,
          <span key="audience" className="text-sm">
            {r.audienceKind === 'groups' ? `指定組別：${r.audienceGroupCodes.join('、') || '（還沒選）'}` : AUDIENCE_LABEL[r.audienceKind]}
          </span>,
          <span key="date" className="tabular-nums text-sm">
            {r.dueAt
              ? `${formatTaipeiMinute(r.dueAt)} 截止`
              : r.actualOpenedAt
                ? `${formatTaipeiMinute(r.actualOpenedAt)} 發布`
                : '—'}
          </span>,
          <span key="roster" className="tabular-nums text-sm">
            {collectsResponses(r.placement)
              ? r.status === 'draft'
                ? RECEIVER_UNIT_LABEL[r.receiverUnit]
                : `${r.rosterCount} ${r.receiverUnit === 'group' ? '組' : '位'}（${RECEIVER_UNIT_LABEL[r.receiverUnit]}）`
              : '—'}
          </span>,
          <Link key="edit" href={`/dashboard/admin/editor/${r.id}`} className="whitespace-nowrap text-sm font-medium text-primary hover:underline">
            編輯
          </Link>,
        ])}
        empty={filter === 'all' ? '這一屆還沒有任何專題事務。按「新增項目」建立第一筆。' : '這個種類還沒有項目。'}
      />
    </>,
  )
}
