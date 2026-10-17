import 'server-only'
import { uuidv7 } from 'uuidv7'
import type { Pool } from 'pg'
import { statusGate, type ResolvedActor } from '@/application/accounts'
import { canManageCohorts } from '@/application/cohorts'
import { readSchemeStages, type CohortGradingSnapshot, type GradingSnapshotQuery, type Settlement } from '@/application/grading'
import { cohortNotFound } from '@/infrastructure/cohorts/shared'
import { getPool } from '@/infrastructure/db/client'
import { loadFacts } from '@/infrastructure/grading/facts'
import {
  assembleAdminBoard,
  isUuid,
  latestEvaluations,
  loadActiveTeachers,
  loadBoardAssignments,
  loadBoardRequirements,
  stageOf,
  type CohortRow,
  type SchemeRow,
  type VersionRow,
} from '@/infrastructure/grading/pg-grading'
import {
  assembleGradebook,
  dissolvedVersions,
  loadGradebookGroups,
  loadGradebookMembers,
  loadGradebookOverrides,
} from '@/infrastructure/grading/pg-grading-results'
import { err, ok, type Result } from '@/shared/result'

/**
 * 屆別評分快照（B 階段 TE-B6；設計方案 §4）：系辦成績管理頁原本 `adminBoard` 與 `gradebook` 各讀一次屆別、方案版本、組別、
 * 要求份數與指派（17 句、3 句重複），這裡每樣只讀一次，兩個 DTO 用跟原 port 同一個組裝函式組出來，所以內容逐一相同。
 *
 * 固定句數（不隨組數長）：屆別 → { 方案頭＋版本、組別＋主指導、要求份數、有效指派、可指派老師、現行結算 } →
 * { `loadFacts`（份數、採計、有效指派三句）、組員、更正、解散組的釘住版本（有解散的組才查）、最新評分 }。
 *
 * - `board.groups` 從成績表的組別取進行中的那些（同一段主指導 join，代號排序）；組別只有 active／dissolved 兩種狀態
 *   （`groups_status_check`），所以「本屆全部組」＝成績表的組，要求份數與指派的範圍兩邊一樣。
 * - 只讀，不開交易、不加鎖（跟 `adminBoard`／`gradebook` 一樣）。
 */

type SchemeVersionJoinRow = {
  scheme_id: string
  cohort_id: string
  current_version_id: string | null
  revision: number
  id: string | null
  version_no: number | null
  stages: unknown
  status: VersionRow['status'] | null
  created_at: Date | null
  locked_at: Date | null
}

type SettlementRow = {
  id: string
  stage_key: string
  settled_at: Date
  settled_by_user_id: string
  settled_by_name: string
  reason: string
  counted_evaluations: number
}

function forbidden(actor: ResolvedActor) {
  const blocked = statusGate(actor, 'business')
  if (blocked) return err(blocked, '請先登入並完成帳號設定。')
  if (!canManageCohorts(actor)) return err('FORBIDDEN', '只有系辦可以看評分管理。')
  return null
}

/** 方案頭列與全部版本一句查完（新的版本在前）；還沒有方案是空的。 */
async function loadSchemeAndVersions(db: Pick<Pool, 'query'>, cohortId: string): Promise<{ scheme: SchemeRow | null; versions: VersionRow[] }> {
  const rows = (
    await db.query<SchemeVersionJoinRow>(
      `select s.id as scheme_id, s.cohort_id, s.current_version_id, s.revision,
              v.id, v.version_no, v.stages, v.status, v.created_at, v.locked_at
         from grading_schemes s left join grading_scheme_versions v on v.scheme_id = s.id
        where s.cohort_id = $1
        order by v.version_no desc`,
      [cohortId],
    )
  ).rows
  const head = rows[0]
  if (!head) return { scheme: null, versions: [] }
  return {
    scheme: { id: head.scheme_id, cohort_id: head.cohort_id, current_version_id: head.current_version_id, revision: head.revision },
    versions: rows
      .filter((r) => r.id !== null)
      .map((r) => ({
        id: r.id!,
        scheme_id: r.scheme_id,
        version_no: r.version_no!,
        stages: r.stages,
        status: r.status!,
        created_at: r.created_at!,
        locked_at: r.locked_at,
      })),
  }
}

/** 本屆現行（未解除）的結算，依階段代號排序。 */
async function loadActiveSettlements(db: Pick<Pool, 'query'>, cohortId: string): Promise<SettlementRow[]> {
  const rows = await db.query<SettlementRow>(
    `select gs.id, gs.stage_key, gs.settled_at, gs.settled_by_user_id,
            coalesce(nullif(btrim(sp.display_name), ''), su.name) as settled_by_name, gs.reason, gs.counted_evaluations
       from grade_settlements gs
       join users su on su.id = gs.settled_by_user_id
       left join user_profiles sp on sp.user_id = gs.settled_by_user_id
      where gs.cohort_id = $1 and gs.released_at is null
      order by gs.stage_key`,
    [cohortId],
  )
  return rows.rows
}

export class PgGradingSnapshotQuery implements GradingSnapshotQuery {
  readonly #reader: () => Pick<Pool, 'query'>

  constructor(reader: () => Pick<Pool, 'query'> = getPool) {
    this.#reader = reader
  }

  async cohortSnapshot(actor: ResolvedActor, cohortId: string): Promise<Result<CohortGradingSnapshot>> {
    const denied = forbidden(actor)
    if (denied) return denied
    if (!isUuid(cohortId)) return cohortNotFound()
    const db = this.#reader()
    const cohort = (await db.query<CohortRow>('select id, code, name, status from cohorts where id = $1', [cohortId])).rows[0]
    if (!cohort) return cohortNotFound()

    const [{ scheme, versions }, groups, requirements, assignments, teachers, settlementRows] = await Promise.all([
      loadSchemeAndVersions(db, cohortId),
      loadGradebookGroups(db, cohortId),
      loadBoardRequirements(db, cohortId),
      loadBoardAssignments(db, cohortId),
      loadActiveTeachers(db),
      loadActiveSettlements(db, cohortId),
    ])
    const ids = groups.map((g) => g.id)
    const [facts, members, overrides, pinned, latest] = await Promise.all([
      loadFacts(db, ids),
      loadGradebookMembers(db, ids),
      loadGradebookOverrides(db, ids),
      dissolvedVersions(db, groups.filter((g) => g.dissolved).map((g) => g.id)),
      latestEvaluations(
        db,
        assignments.map((a) => a.id),
      ),
    ])

    const board = assembleAdminBoard({
      cohort,
      scheme,
      versionRows: versions,
      groups: groups.filter((g) => !g.dissolved),
      requirements,
      assignments,
      latest,
      teachers,
    })
    const current = versions.find((v) => v.id === scheme?.current_version_id)
    const currentStages = current ? readSchemeStages(current.stages) : []
    const gradebook = assembleGradebook({
      cohort,
      version: current ? { id: current.id, versionNo: current.version_no, stages: currentStages } : null,
      groups,
      facts,
      members,
      overrides,
      pinned,
    })
    const settlements: Settlement[] = settlementRows.map((r) => ({
      settlementId: r.id,
      cohortId: cohort.id,
      stageKey: r.stage_key,
      // 從目前方案版本找；套用新版本後找不到就是 `stageKey`（同結算查詢）。
      stageName: stageOf(currentStages, r.stage_key)?.name ?? r.stage_key,
      settledAt: r.settled_at,
      settledBy: { userId: r.settled_by_user_id, name: r.settled_by_name },
      reason: r.reason,
      countedEvaluations: r.counted_evaluations,
    }))
    const serverTime = new Date()
    return ok({ board, gradebook, settlements, loadedAt: serverTime }, { requestId: uuidv7(), serverTime: serverTime.toISOString() })
  }
}
