/**
 * 測試地圖的格子判定（設計方案 §3.9）：角色 × 功能，每格 ✅／⚠️／⬜／—。
 *
 * 資料只有兩份：最新一次 full 驗收那夜的 summary.json，和 repo 的 test-map.json。
 * 純函式、不讀檔，畫面與測試共用。
 */
import type {
  RoleKey,
  SummaryItem,
  SummaryJson,
  SummaryProblem,
  SummaryStep,
  TestMapFeature,
  TestMapFile,
  TestMapSection,
} from '../data/types'
import { testSiteUrl } from './links'

/**
 * - `na`：不適用（角色不在功能的 roles）
 * - `untested`：⬜ 沒測到（沒有任何步驟列）
 * - `warn`：⚠️ 有狀況（有步驟不是「通過」，或步驟上有「擋上線」「要修」）
 * - `parse-failed`：⚠️ 報告解析失敗（item 的 parsed 不是 true 或 errors 非空；problems 不可信）
 * - `ok`：✅ 有點過
 */
export type CellStatus = 'na' | 'untested' | 'warn' | 'parse-failed' | 'ok'

/** 算「有問題」的嚴重度；「建議」「待 Roy 決定」只列出、不影響格子。 */
export const BLOCKING_SEVERITIES = ['擋上線', '要修']

export type CellStep = {
  item: string
  stepNo: number
  step: SummaryStep
  /** 同 item、`步驟` 欄開頭整數等於這一步的問題（各種嚴重度都列） */
  problems: SummaryProblem[]
}

export type ParseFailure = { item: string; errors: string[] }

export type MapCell = {
  role: RoleKey
  status: CellStatus
  steps: CellStep[]
  /** 這格用到的 item 裡解析失敗的那些（抽屜頂端要列） */
  parseFailures: ParseFailure[]
}

export type MapRow = { feature: TestMapFeature; cells: MapCell[] }

export type StaleRef = { item: string; step: number }

export type TestMapView = {
  roles: TestMapFile['roles']
  rows: MapRow[]
  /** evidence 指到、該夜 summary.json 卻沒有的步驟（頁頂黃條） */
  stale: StaleRef[]
  /** evidence 步驟列的 `角色` 對不到任何別名的原字串（頁尾） */
  unknownRoles: string[]
}

/** `步驟` 欄開頭的整數（`"1 記下測試站版本"` → 1）；沒有就是 null。 */
export function stepNumber(text: unknown): number | null {
  const m = typeof text === 'string' ? /^\s*(\d+)/.exec(text) : null
  return m ? Number(m[1]) : null
}

/** item 解析失敗的原因；沒失敗是 null。 */
function parseFailure(item: SummaryItem): ParseFailure | null {
  const errors = Array.isArray(item.errors) ? item.errors.map(String) : []
  if (item.parsed === true && errors.length === 0) return null
  return { item: item.id, errors: errors.length > 0 ? errors : ['parsed 不是 true'] }
}

const RANK: Record<CellStatus, number> = { na: -1, ok: 0, untested: 1, warn: 2, 'parse-failed': 3 }

/** 幾格裡最差的結果；全部不適用就是 na。 */
export function worstStatus(statuses: CellStatus[]): CellStatus {
  return statuses.reduce<CellStatus>((worst, s) => (RANK[s] > RANK[worst] ? s : worst), 'na')
}

export function buildTestMap(testMap: TestMapFile, summary: SummaryJson): TestMapView {
  const items = new Map((summary.items ?? []).map((it) => [it.id, it]))
  const aliasToRole = new Map<string, RoleKey>()
  for (const role of testMap.roles) for (const alias of role.aliases) aliasToRole.set(alias, role.key)

  const stale: StaleRef[] = []
  const staleSeen = new Set<string>()
  const unknownRoles: string[] = []

  const rows = testMap.features.map((feature): MapRow => {
    // 先把這個功能的證據步驟找齊，再依角色分到各格。
    type Bucket = { steps: CellStep[]; failures: Map<string, ParseFailure> }
    const byRole = new Map<RoleKey, Bucket>()
    for (const ev of feature.evidence) {
      const item = items.get(ev.item)
      const failure = item ? parseFailure(item) : null
      for (const no of ev.steps) {
        const row = item?.steps?.find((s) => stepNumber(s.步驟) === no)
        if (!row) {
          const key = `${ev.item}#${no}`
          if (!staleSeen.has(key)) {
            staleSeen.add(key)
            stale.push({ item: ev.item, step: no })
          }
          continue
        }
        const role = aliasToRole.get(row.角色)
        if (!role) {
          if (!unknownRoles.includes(row.角色)) unknownRoles.push(row.角色)
          continue
        }
        const problems = (item!.problems ?? []).filter((p) => stepNumber(p.步驟) === no)
        const bucket: Bucket = byRole.get(role) ?? { steps: [], failures: new Map() }
        bucket.steps.push({ item: ev.item, stepNo: no, step: row, problems })
        if (failure) bucket.failures.set(failure.item, failure)
        byRole.set(role, bucket)
      }
    }

    const cells = testMap.roles.map((role): MapCell => {
      if (!feature.roles.includes(role.key)) return { role: role.key, status: 'na', steps: [], parseFailures: [] }
      const bucket = byRole.get(role.key)
      const steps = bucket?.steps ?? []
      const parseFailures = [...(bucket?.failures.values() ?? [])]
      let status: CellStatus
      if (steps.length === 0) status = 'untested'
      else if (parseFailures.length > 0) status = 'parse-failed'
      else if (steps.some((s) => s.step.結果 !== '通過' || s.problems.some((p) => BLOCKING_SEVERITIES.includes(p.嚴重度))))
        status = 'warn'
      else status = 'ok'
      return { role: role.key, status, steps, parseFailures }
    })
    return { feature, cells }
  })

  return { roles: testMap.roles, rows, stale, unknownRoles }
}

export type SectionRow = {
  section: TestMapSection
  /** 管理後台頁在測試站的網址；沒有後台是 null */
  adminUrl: string | null
  /** `adminPage` 是 null 又沒有 `exception`：前台有這區但沒有後台（標紅） */
  missingAdmin: boolean
  /** frontFeature 各角色格的最差結果；沒有彙整結果或地圖沒這個功能是 null */
  front: CellStatus | null
  /** adminFeature 的系辦格；沒有 adminFeature、沒有彙整結果或地圖沒這個功能是 null */
  admin: CellStatus | null
}

/** 第二張表「前台每一區」（Q27）。`view` 是 null 表示最新一夜沒有彙整結果。 */
export function buildSections(testMap: TestMapFile, view: TestMapView | null): SectionRow[] {
  const row = (key: string | null) => (key && view ? view.rows.find((r) => r.feature.key === key) : undefined)
  return testMap.sections.map((section) => {
    const front = row(section.frontFeature)
    const admin = row(section.adminFeature)
    return {
      section,
      adminUrl: section.adminPage ? testSiteUrl(section.adminPage) : null,
      missingAdmin: section.adminPage === null && !section.exception,
      front: front ? worstStatus(front.cells.map((c) => c.status)) : null,
      admin: admin ? (admin.cells.find((c) => c.role === 'admin')?.status ?? 'na') : null,
    }
  })
}
