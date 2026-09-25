import Link from 'next/link'
import { requireRole } from '@/app/_ui/guard'
import { PageTitle, pillClass } from '@/app/_ui/dashboard-kit'
import { EmptyState, LinkButton } from '@/app/_ui/primitives'
import { DashboardShell } from '@/app/_ui/site-shell'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { AffairsList, type AffairRow } from '@/app/dashboard/admin/affairs/affairs-list'
import { QuickCreateDialog } from '@/app/dashboard/admin/affairs/quick-create-dialog'
import { editorVocabulary } from '@/app/dashboard/admin/affairs/vocabulary'
import { COHORT_STATUS_LABEL, getBusinessClock, getCohortStatusQuery } from '@/composition/cohorts'
import {
  AUDIENCE_LABEL,
  collectsResponses,
  getItemQuery,
  ITEM_STATUS_LABEL,
  PLACEMENT_LABEL,
  RECEIVER_UNIT_LABEL,
} from '@/composition/items'
import { formatTaipeiDate, formatTaipeiMinute, taipeiDateOf } from '@/shared/time'

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

  const shell = (description: string, children: React.ReactNode, actions?: React.ReactNode) => (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/affairs">
      <div className="flex flex-col gap-5">
        <PageTitle title="專題事務" description={description} actions={actions} />
        {children}
      </div>
    </DashboardShell>
  )

  if (!cohort) {
    return shell(
      '公告、資源下載、文件繳交都從這裡建立、發布與修改。',
      <EmptyState
        title="還沒有屆別"
        description="專題事務要綁在某一屆；先到屆別頁新增一屆。"
        action={{ href: '/dashboard/admin/cohorts', label: '前往屆別' }}
      />,
    )
  }

  const [rows, vocabulary, businessNow] = await Promise.all([
    getItemQuery().list(cohort.id),
    editorVocabulary(cohort.id),
    getBusinessClock().now(),
  ])
  const shown = rows.filter((r) => filter === 'all' || r.placement === filter)
  const published = rows.filter((r) => r.status === 'published').length
  const collecting = rows.filter((r) => collectsResponses(r.placement) && r.status === 'published').length
  const query = (patch: Record<string, string>) => {
    const next = new URLSearchParams({ cohort: cohort.id, ...(filter !== 'all' ? { placement: filter } : {}), ...patch })
    if (next.get('placement') === 'all') next.delete('placement')
    return `/dashboard/admin/affairs?${next.toString()}`
  }

  const list: AffairRow[] = shown.map((r) => {
    const collects = collectsResponses(r.placement)
    return {
      id: r.id,
      kind: PLACEMENT_LABEL[r.placement],
      title: r.title,
      status: r.status,
      statusLabel: ITEM_STATUS_LABEL[r.status],
      visibility: r.audienceKind === 'public' ? '網際網路公開' : '登入後可見',
      audience:
        r.audienceKind === 'groups' ? `指定組別：${r.audienceGroupCodes.join('、') || '（還沒選）'}` : AUDIENCE_LABEL[r.audienceKind],
      // 原型這一欄只寫日期；截止多寫到分鐘（23:59 截止跟 00:00 截止差一天）。
      date: r.dueAt ? formatTaipeiMinute(r.dueAt) : r.actualOpenedAt ? formatTaipeiDate(taipeiDateOf(r.actualOpenedAt)) : '—',
      isDue: r.dueAt !== null,
      overdue: r.dueAt !== null && r.dueAt.getTime() < businessNow.getTime(),
      // 收件名單頁（票 18）：數字＝應交數（不含免填），跟名單頁完成率的分母同一個口徑。
      roster: collects
        ? r.status === 'draft'
          ? { text: RECEIVER_UNIT_LABEL[r.receiverUnit], href: null }
          : {
              text: `應交 ${r.rosterCount} ${r.receiverUnit === 'group' ? '組' : '位'}`,
              href: `/dashboard/admin/affairs/${r.id}`,
            }
        : null,
      // 前台頁面：發布中的公告才有自己的內容頁（資源、規則是整頁列表）。
      publicHref: r.placement === 'news' && r.status === 'published' ? `/news/${r.id}` : null,
      editHref: `/dashboard/admin/editor/${r.id}`,
    }
  })

  return shell(
    `${cohort.code}・${COHORT_STATUS_LABEL[cohort.status]}・${rows.length} 項・發布中 ${published}・收件中 ${collecting}`,
    <>
      {cohorts.length > 1 ? (
        <nav aria-label="選擇屆別" className="flex flex-wrap gap-1.5">
          {cohorts.map((c) => (
            <Link
              key={c.id}
              href={`/dashboard/admin/affairs?cohort=${c.id}`}
              aria-current={c.id === cohort.id ? 'page' : undefined}
              className={pillClass(c.id === cohort.id)}
            >
              {c.code}
            </Link>
          ))}
        </nav>
      ) : null}

      <AffairsList
        rows={list}
        filters={FILTERS.map((f) => ({ key: f.key, label: f.label, href: query({ placement: f.key }), active: filter === f.key }))}
        emptyText={filter === 'all' ? '這一屆還沒有任何專題事務。按「新增項目」建立第一筆。' : '這個種類還沒有項目。'}
      />
    </>,
    <>
      <LinkButton href={`/dashboard/admin/editor/new?cohort=${cohort.id}`} variant="secondary">
        用完整編輯器建立
      </LinkButton>
      <QuickCreateDialog cohortId={cohort.id} vocabulary={vocabulary} />
    </>,
  )
}
