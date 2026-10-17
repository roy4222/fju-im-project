/**
 * 公告與作業列表要顯示哪一屆、哪個篩選（純函式；第三波 W1b）。
 *
 * - 一般篩選只列未封存的屆別；「榮譽」篩選連已封存的也列（榮譽是跨屆的公開紀錄）。
 * - 一個屆別都沒有 → `none`（「還沒有屆別」）。
 * - 屆別全部封存、又不是榮譽篩選 → `only-archived`：不能新增一般項目，但要留「歷屆榮譽」入口，不能變成死路。
 */

export const AFFAIRS_FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'news', label: '公告' },
  { key: 'resource', label: '資源' },
  { key: 'submission', label: '文件繳交' },
  { key: 'rules', label: '專題規則' },
  { key: 'honor', label: '榮譽' },
] as const

export type AffairsFilter = (typeof AFFAIRS_FILTERS)[number]['key']

type CohortLike = { readonly id: string; readonly status: string; readonly isDefaultWorking: boolean }

export type AffairsView<C extends CohortLike> =
  | { readonly state: 'none'; readonly filter: AffairsFilter }
  | { readonly state: 'only-archived'; readonly filter: AffairsFilter }
  | { readonly state: 'ok'; readonly filter: AffairsFilter; readonly cohorts: readonly C[]; readonly cohort: C }

export function affairsView<C extends CohortLike>(
  all: readonly C[],
  params: { readonly cohort?: string | string[]; readonly placement?: string | string[] },
): AffairsView<C> {
  const filter = AFFAIRS_FILTERS.find((f) => f.key === params.placement)?.key ?? 'all'
  if (all.length === 0) return { state: 'none', filter }
  const cohorts = filter === 'honor' ? all : all.filter((c) => c.status !== 'archived')
  if (cohorts.length === 0) return { state: 'only-archived', filter }
  const cohort =
    cohorts.find((c) => c.id === params.cohort) ??
    cohorts.find((c) => c.isDefaultWorking) ??
    cohorts.find((c) => c.status !== 'archived') ??
    cohorts[0]!
  return { state: 'ok', filter, cohorts, cohort }
}
