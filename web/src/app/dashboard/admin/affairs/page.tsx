import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireRole } from '@/app/_ui/guard'
import { PageTitle, pillClass } from '@/app/_ui/dashboard-kit'
import { EmptyState, LinkButton } from '@/app/_ui/primitives'
import { DashboardShell } from '@/app/_ui/site-shell'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { AdminTabs } from '@/app/dashboard/admin/_tabs'
import { AFFAIRS_TABS } from '@/app/dashboard/admin/_tabs.consts'
import { AffairsList } from '@/app/dashboard/admin/affairs/affairs-list'
import { AFFAIRS_FILTERS, affairsView, toAffairRow } from '@/app/dashboard/admin/affairs/affairs-view'
import { QuickCreateDialog } from '@/app/dashboard/admin/affairs/quick-create-dialog'
import { editorVocabulary } from '@/app/dashboard/admin/affairs/vocabulary'
import { legacyAdminRedirect } from '@/app/dashboard/admin/legacy-redirects'
import { cohortLabel, getBusinessClock, getCohortStatusQuery } from '@/composition/cohorts'
import { getItemQuery } from '@/composition/items'
import { completionOf, getRosterQuery } from '@/composition/submissions'
import { isDeadlinePassed } from '@/shared/time'

export const metadata = { title: '公告與作業｜資管系專題平台' }

const BASE = '/dashboard/admin/affairs'
const FILTERS = AFFAIRS_FILTERS

/**
 * 公告與作業工作台（票 15；原型 `/dashboard/admin/affairs`）。
 *
 * 公告、資源、文件繳交全部從這裡建立：日常用「新增項目」三步驟，要細調欄位、附件、封面再進完整編輯器
 * （同一個項目 ID）。編輯器不另放側欄入口（產品模組 04「單一入口」）。
 * 撤回、下架、重新發布在完整編輯器的頂列（票 16）；收件進度與名單頁在票 18。
 *
 * 榮譽是跨屆的公開紀錄（第三波 W1／W1b）：選「榮譽」篩選時，屆別選單連已封存的屆別也列出來，
 * 系辦才點得到歷屆（例如示範資料 DEMO-113、DEMO-112）的榮譽並進編輯器；頁首多一顆「新增榮譽」，帶目前選的屆別。
 * 封存屆別只能動榮譽，所以那時不放「新增項目」與一般的完整編輯器入口。屆別全部封存時，一般篩選改成說明＋
 * 「管理歷屆榮譽」入口（不是「還沒有屆別」的死路）。
 *
 * 系辦 AD-04：標題用側欄名「公告與作業」、下方掛分頁列；頁首不放說明段落（AC-AD-06、07）。
 *
 * 「逾期」篩選（AD-B7）：發布中、已截止、還有人沒正式送出的文件繳交，列上寫「逾期 N 人」。只有這個篩選才多讀
 * 一次全屆名單事實（`completionFacts`，跟系辦首頁逾期卡同一個查詢、同一個 `completionOf`），其他篩選的查詢不變。
 *
 * 資源、作業、專題規則各有自己的分頁（C 階段規格② §2.2：`affairs/{resources,assignments,rules}`）；
 * 舊的 `?placement=resource|submission|requirement|rules` 書籤先守衛、再轉到對應分頁（`legacy-redirects.ts`）。
 */
export default async function AffairsPage({
  searchParams,
}: {
  searchParams: Promise<{ cohort?: string | string[]; placement?: string | string[] }>
}) {
  const actor = await requireRole(BASE, 'admin')
  const params = await searchParams
  const legacy = legacyAdminRedirect(BASE, params)
  if (legacy) redirect(legacy)

  const view = affairsView(await getCohortStatusQuery().list(), { ...params, placement: params.placement ?? 'news' })
  const filter = view.filter
  const honorView = filter === 'honor'

  const shell = (children: React.ReactNode, actions?: React.ReactNode) => (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current={BASE}>
      <PageTitle title="公告與作業" />
      <div className="mt-4">
        <AdminTabs label="公告與作業分頁" current={BASE} items={AFFAIRS_TABS} actions={actions} />
      </div>
      <p data-testid="tab-intro" className="-mt-2 mb-4 text-sm text-muted-foreground">
        這一屆的公告與歷屆榮譽都在這裡；作業、資源下載、專題規則各有自己的分頁。
      </p>
      <div className="flex flex-col gap-5">{children}</div>
    </DashboardShell>
  )

  if (view.state === 'only-archived') {
    return shell(
      <EmptyState
        title="屆別都已封存"
        description="封存的屆別不能再新增公告、資源或作業；榮譽是跨屆的公開紀錄，仍可新增、編輯、下架或刪除。要開始新的一屆請到屆別頁。"
        action={{ href: '/dashboard/admin/affairs?placement=honor', label: '管理歷屆榮譽' }}
      />,
    )
  }

  if (view.state === 'none') {
    return shell(
      <EmptyState
        title="還沒有屆別"
        description="公告與作業要綁在某一屆；先到屆別頁新增一屆。"
        action={{ href: '/dashboard/admin/cohorts', label: '前往屆別' }}
      />,
    )
  }

  const { cohorts, cohort } = view
  const [rows, vocabulary, businessNow, facts] = await Promise.all([
    getItemQuery().list(cohort.id),
    editorVocabulary(cohort.id),
    getBusinessClock().now(),
    filter === 'overdue' ? getRosterQuery().completionFacts(actor, cohort.id) : Promise.resolve([]),
  ])
  // 每份收件的欠繳數：口徑同名單頁與首頁逾期卡（目前名單、不含免填與移出、沒有正式版本、狀態是逾期）。
  const overdueOf = new Map(facts.map((f) => [f.item.itemId, completionOf(f.item, f.entries, businessNow).overdue]))
  const shown = rows.filter((r) =>
    filter === 'overdue'
      ? r.placement === 'submission' &&
        r.status === 'published' &&
        r.dueAt !== null &&
        isDeadlinePassed(businessNow, r.dueAt) &&
        (overdueOf.get(r.id) ?? 0) > 0
      : filter === 'all' || r.placement === filter,
  )
  // 封存屆別只會在榮譽篩選下出現；那時只能動榮譽。
  const archived = cohort.status === 'archived'
  const query = (patch: Record<string, string>) => {
    const next = new URLSearchParams({ cohort: cohort.id, placement: filter, ...patch })
    return `/dashboard/admin/affairs?${next.toString()}`
  }

  const list = shown.map((r) =>
    toAffairRow(r, businessNow, {
      overdueText: filter === 'overdue' ? `逾期 ${overdueOf.get(r.id) ?? 0} ${r.receiverUnit === 'group' ? '組' : '人'}` : null,
    }),
  )

  return shell(
    <>
      {cohorts.length > 1 ? (
        <nav aria-label="選擇屆別" className="flex flex-wrap gap-1.5">
          {cohorts.map((c) => (
            <Link
              key={c.id}
              // 榮譽篩選下換屆別仍停在榮譽（才看得到封存屆別）；其他篩選照舊回到全部。
              href={honorView || filter === 'all' ? query({ cohort: c.id }) : `/dashboard/admin/affairs?cohort=${c.id}`}
              aria-current={c.id === cohort.id ? 'page' : undefined}
              className={pillClass(c.id === cohort.id)}
            >
              {cohortLabel(c)}
              {c.status === 'archived' ? <span className="ml-1 text-xs font-normal opacity-80">（已封存）</span> : null}
            </Link>
          ))}
        </nav>
      ) : null}
      {honorView ? (
        <p className="text-sm text-muted-foreground" data-testid="honor-list-hint">
          榮譽是跨屆的公開紀錄：上方屆別含已封存的屆別，選那一屆就看得到歷屆榮譽，可以編輯、下架、重新發布或刪除。發布中的會出現在前台
          <Link href="/honors" className="mx-0.5 font-semibold text-foreground underline underline-offset-2">
            「榮譽榜」
          </Link>
          。
        </p>
      ) : null}

      <AffairsList
        rows={list}
        filters={FILTERS.map((f) => ({ key: f.key, label: f.label, href: query({ placement: f.key }), active: filter === f.key }))}
        emptyText={
          filter === 'all'
            ? '這一屆還沒有任何項目。按「新增公告」建立第一筆。'
            : filter === 'news'
              ? '這一屆還沒有公告。按「新增公告」建立第一筆。'
            : honorView
              ? '這一屆還沒有榮譽。按「新增榮譽」建立第一則。'
              : filter === 'overdue'
                ? '這一屆目前沒有逾期未繳的文件繳交。'
                : '這個種類還沒有項目。'
        }
      />
    </>,
    <>
      {honorView ? (
        <LinkButton href={`/dashboard/admin/editor/new?cohort=${cohort.id}&placement=honor`} variant={archived ? 'primary' : 'secondary'}>
          新增榮譽
        </LinkButton>
      ) : null}
      {archived ? null : (
        <>
          <LinkButton href={`/dashboard/admin/editor/new?cohort=${cohort.id}`} variant="secondary">
            完整編輯器
          </LinkButton>
          <QuickCreateDialog cohortId={cohort.id} vocabulary={vocabulary} label="新增公告" placement="news" />
        </>
      )}
    </>,
  )
}
