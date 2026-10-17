import { IconClipboardText } from '@tabler/icons-react'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { TEACHER_NAV } from '@/app/dashboard/_nav'
import { PageTitle, Panel, PanelEmpty } from '@/app/dashboard/teacher/_ui/dash'
import { TabNav } from '@/app/dashboard/teacher/_ui/tab-nav'
import { CohortSelect, type CohortOption } from '@/app/dashboard/teacher/affairs/cohort-select'
import { EntryList } from '@/app/dashboard/teacher/affairs/entry-list'
import { buildGroupCards, GroupCards, type GroupCard } from '@/app/dashboard/teacher/affairs/group-cards'
import { SignoffTab } from '@/app/dashboard/teacher/affairs/signoff-tab'
import type { ResolvedActor } from '@/application/accounts'
import type { AdvisorIndividualItem } from '@/application/submissions'
import { getBusinessClock, cohortLabel } from '@/composition/cohorts'
import { getSignoffQuery } from '@/composition/signoff'
import { getAdvisorSubmissionQuery } from '@/composition/submissions'

export const metadata = { title: '作業區｜資管系專題平台' }

const BASE = '/dashboard/teacher/affairs'
const TABS = [
  { key: 'submissions', label: '各組繳交', href: BASE },
  { key: 'signoff', label: '同意書', href: `${BASE}?tab=signoff` },
] as const

const DESCRIPTION = {
  submissions: '你指導的每一組一張卡，一個小方塊一份作業。點小方塊看那一組每一次正式送出的內容。',
  signoff: '你此刻指導的組別的同意書與進度。組員全部同意後才輪到你。',
} as const

/**
 * 老師作業區（TE-04，Q77、Q83）：分頁 `?tab=submissions`（預設）｜`?tab=signoff`。
 *
 * - 各組繳交：只列老師**此刻**指導的組別（換掉的組下一次打開就不見了），每組一張卡、每份整組作業一個小方塊；
 *   下面另列系辦開了主指導閱覽的個人作業。
 * - 同意書：原 `/dashboard/teacher/signoff` 的卡片（那個網址先過角色檢查再轉到這裡）。
 *
 * 每個分頁只讀自己要的資料（一次 `Promise.all`）：各組繳交＝`matrix`＋業務時間；同意書＝`teacherView`。
 * 不認得的 `tab` 一律當「各組繳交」，不轉頁（`pages.spec` 要直接拿到 200）。
 */
export default async function TeacherAffairsPage({ searchParams }: { searchParams: Promise<{ tab?: string | string[]; cohort?: string | string[] }> }) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole(BASE, 'teacher')
  const params = await searchParams
  const cohort = typeof params.cohort === 'string' ? params.cohort : undefined
  const data = await loadAffairs(actor, params.tab === 'signoff' ? 'signoff' : 'submissions', cohort)

  return (
    <DashboardShell roleLabel="老師" items={TEACHER_NAV} current={BASE}>
      <div className="flex flex-col gap-5">
        <PageTitle title="作業區" description={DESCRIPTION[data.tab]} />
        <TabNav label="作業區分頁" tabs={TABS} current={data.tab} />
        {data.tab === 'signoff' ? <SignoffTab cards={data.cards} /> : <SubmissionsTab {...data} />}
      </div>
    </DashboardShell>
  )
}

/** 這一頁唯一的讀取入口：依分頁只讀那一頁要的資料。 */
async function loadAffairs(actor: ResolvedActor, tab: 'submissions' | 'signoff', cohortId: string | undefined) {
  if (tab === 'signoff') return { tab, cards: await getSignoffQuery().teacherView(actor) } as const
  const [matrix, businessNow] = await Promise.all([getAdvisorSubmissionQuery().matrix(actor, cohortId), getBusinessClock().now()])
  const cohorts = matrix?.cohorts ?? []
  const options: CohortOption[] = cohorts.map((c) => ({ cohortId: c.cohortId, label: cohortLabel({ name: c.name, code: c.code }), archived: c.archived }))
  // 網址上的屆別不是老師曾經指導過的屆別（亂填）：下拉回到預設，矩陣本來就是空的。UUID 不分大小寫。
  const picked = cohorts.find((c) => c.cohortId === cohortId?.toLowerCase())
  return {
    tab,
    cards: matrix ? buildGroupCards(matrix, businessNow) : [],
    individual: matrix?.individualItems ?? [],
    options,
    current: picked?.cohortId ?? '',
    archived: picked?.archived ?? false,
  } as const
}

function SubmissionsTab({
  cards,
  individual,
  options,
  current,
  archived,
}: {
  cards: readonly GroupCard[]
  individual: readonly AdvisorIndividualItem[]
  options: readonly CohortOption[]
  current: string
  archived: boolean
}) {
  const hasItems = cards.some((c) => c.cells.length > 0)
  return (
    <>
      {options.length > 0 ? <CohortSelect options={options} current={current} /> : null}
      {archived ? (
        <p role="note" data-testid="cohort-archived-note" className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
          這一屆已封存，資料只供查看，不能再修改。
        </p>
      ) : null}
      <Panel title="各組繳交" icon={<IconClipboardText />} description={cards.length > 0 ? `${cards.length} 組` : undefined}>
        {cards.length === 0 ? (
          <PanelEmpty icon={<IconClipboardText />} title="你目前沒有指導中的組別。" action={{ href: '/dashboard/teacher/groups', label: '到分組總覽' }} />
        ) : !hasItems ? (
          <PanelEmpty icon={<IconClipboardText />} title="還沒有整組一份的作業" hint="系辦發布整組一份的作業之後，會在這裡列出你指導的每一組交了沒。" />
        ) : (
          <GroupCards cards={cards} />
        )}
      </Panel>
      <EntryList items={individual} />
    </>
  )
}
