import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireRole } from '@/app/_ui/guard'
import { PageTitle, pillClass } from '@/app/_ui/dashboard-kit'
import { EmptyState } from '@/app/_ui/primitives'
import { DashboardShell } from '@/app/_ui/site-shell'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { AdminTabs } from '@/app/dashboard/admin/_tabs'
import { AFFAIRS_TABS } from '@/app/dashboard/admin/_tabs.consts'
import { NewItemButton } from '@/app/dashboard/admin/affairs/_content/list-actions'
import { AffairsNewsList, newsFilterOf } from '@/app/dashboard/admin/affairs/_content/news-list'
import { affairsView } from '@/app/dashboard/admin/affairs/affairs-view'
import { editorVocabulary } from '@/app/dashboard/admin/affairs/vocabulary'
import { legacyAdminRedirect } from '@/app/dashboard/admin/legacy-redirects'
import { cohortLabel, getCohortStatusQuery } from '@/composition/cohorts'

export const metadata = { title: '公告與作業｜資管系專題平台' }

const BASE = '/dashboard/admin/affairs'

/**
 * 公告與作業工作台（票 15；原型 `/dashboard/admin/affairs`）。
 *
 * 清單內容是規格①的 `AffairsNewsList`（C1-07：只列公告、置頂在列上的「⋯」、刪除鈕寫原因）；右上「新增」直接開公告表單
 * （`NewItemButton`，不問類型）。編輯器不另放側欄入口（產品模組 04「單一入口」）。
 *
 * 榮譽（含封存屆別的歷屆榮譽）在「成果展示」分頁的榮譽榜區（C1-09）；這頁只列未封存的屆別。屆別全部封存時改成說明＋
 * 「成果展示」入口（不是「還沒有屆別」的死路）。
 *
 * 系辦 AD-04：標題用側欄名「公告與作業」、下方掛分頁列；頁首不放說明段落（AC-AD-06、07）。
 *
 * 「逾期」篩選（AD-B7）與「全部」暫留在清單元件裡（見 `news-list.tsx`）。
 *
 * 資源、作業、專題規則各有自己的分頁（C 階段規格② §2.2：`affairs/{resources,assignments,rules}`）；
 * 舊的 `?placement=resource|submission|requirement|rules` 書籤先守衛、再轉到對應分頁（`legacy-redirects.ts`）。
 */
export default async function AffairsPage({
  searchParams,
}: {
  searchParams: Promise<{ cohort?: string | string[]; placement?: string | string[]; q?: string | string[]; status?: string | string[] }>
}) {
  await requireRole(BASE, 'admin')
  const params = await searchParams
  const legacy = legacyAdminRedirect(BASE, params)
  if (legacy) redirect(legacy)

  const view = affairsView(await getCohortStatusQuery().list(), { ...params, placement: newsFilterOf(params) })
  const filter = view.filter

  const shell = (children: React.ReactNode, actions?: React.ReactNode) => (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current={BASE}>
      <PageTitle title="公告與作業" />
      <div className="mt-4">
        <AdminTabs label="公告與作業分頁" current={BASE} items={AFFAIRS_TABS} actions={actions} />
      </div>
      <p data-testid="tab-intro" className="-mt-2 mb-4 text-sm text-muted-foreground">
        這一屆的公告都在這裡；作業、資源下載、專題規則各有自己的分頁。
      </p>
      <div className="flex flex-col gap-5">{children}</div>
    </DashboardShell>
  )

  if (view.state === 'only-archived') {
    return shell(
      <EmptyState
        title="屆別都已封存"
        description="封存的屆別不能再新增公告、資源或作業；歷屆榮譽在「成果展示」的榮譽榜區管理。要開始新的一屆請到屆別頁。"
        action={{ href: '/dashboard/admin/showcase', label: '前往成果展示' }}
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
  const vocabulary = await editorVocabulary(cohort.id)

  return shell(
    <>
      {cohorts.length > 1 ? (
        <nav aria-label="選擇屆別" className="flex flex-wrap gap-1.5">
          {cohorts.map((c) => (
            <Link
              key={c.id}
              // 換屆別停在同一個種類篩選。
              href={`/dashboard/admin/affairs?${new URLSearchParams({ cohort: c.id, ...(filter === 'news' ? {} : { placement: filter }) }).toString()}`}
              aria-current={c.id === cohort.id ? 'page' : undefined}
              className={pillClass(c.id === cohort.id)}
            >
              {cohortLabel(c)}
            </Link>
          ))}
        </nav>
      ) : null}
      <AffairsNewsList cohortId={cohort.id} searchParams={params} />
    </>,
    <NewItemButton cohortId={cohort.id} vocabulary={vocabulary} placement="news" noun="公告" />,
  )
}
