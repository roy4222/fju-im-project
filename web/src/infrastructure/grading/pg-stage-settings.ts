import 'server-only'
import type { Pool, PoolClient } from 'pg'
import type { ResolvedActor } from '@/application/accounts'
import type { BusinessClockSource } from '@/application/cohorts'
import {
  describePanelMismatch,
  normalizeStageSetting,
  panelMismatches,
  readSchemeStages,
  type GradingStageSettingCommand,
  type GradingStageSettingQuery,
  type PanelGroupFacts,
  type SchemeStage,
  type SetStageSettingInput,
  type StageSetting,
} from '@/application/grading'
import { canonicalJson, type AuditWriter, type OperationLedger } from '@/application/ops'
import { authorizeAdmin, badRequestId, replayed, type PoolSource } from '@/infrastructure/cohorts/shared'
import { getPool } from '@/infrastructure/db/client'
import { archived, isUuid, lockCohort, okList, runGrading, stageOf, type SchemeRow } from '@/infrastructure/grading/pg-grading'
import { sha256 } from '@/infrastructure/ops/audit-writer'
import { err, type Result } from '@/shared/result'
import { RealClock, type Clock } from '@/shared/time'

/**
 * 評分項目的側表（C 階段 C1-04；設計方案① §1.3、§3.4）：系辦設定每個評分項目「對應哪份作業」「給老師看的說明」「評審組」。
 *
 * 三樣都不影響分數：改了不建新版、不鎖方案、不重算。只認目前已發布版本的項目（還沒發布過就不能寫）；
 * 發布或套用新版本時，新版沒有的項目由 `pg-grading.ts` 的 `dropStaleStageSettings` 同交易刪掉。
 *
 * 鎖順序：`cohorts FOR SHARE` → `grading_schemes FOR UPDATE`。指派、移除、改份數都拿方案頭列 `FOR SHARE`
 * （`lockGroupAndScheme`），所以「檢查評審組一致 → 寫入」這段不會被同時的指派插隊；評審組展開在那把鎖內讀側表。
 */

type Deps = {
  audit: AuditWriter<PoolClient>
  ledger: OperationLedger<PoolClient>
  businessClock: BusinessClockSource
  pool?: PoolSource
  realClock?: Clock
}

type ItemRow = {
  id: string
  title: string
  cohort_id: string
  placement: string
  receiver_unit: string
  status: string
  consent_mode: string | null
  deleted_at: Date | null
}

function noPublishedScheme() {
  return err('VALIDATION_FAILED', '請先發布評分規則，才能設定評分項目的對應作業、說明與評審組。')
}

export class PgGradingStageSettingCommand implements GradingStageSettingCommand {
  readonly #audit: AuditWriter<PoolClient>
  readonly #ledger: OperationLedger<PoolClient>
  readonly #businessClock: BusinessClockSource
  readonly #pool: PoolSource
  readonly #realClock: Clock

  constructor(deps: Deps) {
    this.#audit = deps.audit
    this.#ledger = deps.ledger
    this.#businessClock = deps.businessClock
    this.#pool = deps.pool ?? getPool
    this.#realClock = deps.realClock ?? new RealClock()
  }

  async setStageSetting(actor: ResolvedActor, input: SetStageSettingInput, requestId: string): Promise<Result<StageSetting>> {
    const denied = authorizeAdmin(actor, '設定評分項目')
    if (denied) return denied
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(input.cohortId)) return err('VALIDATION_FAILED', '請先選屆別。')
    const stageKey = typeof input.stageKey === 'string' ? input.stageKey : ''
    const normalized = normalizeStageSetting(input)
    if (!normalized.ok) return normalized
    const { itemId, description, panelKey } = normalized.value
    const adminId = actor.kind === 'authenticated' ? actor.userId : ''
    const businessNow = await this.#businessClock.now()

    return runGrading(this.#pool, async (tx) => {
      const cohort = await lockCohort(tx, input.cohortId)
      if (!cohort) return err('VALIDATION_FAILED', '找不到這個屆別，請重新整理頁面。')
      const scheme = (
        await tx.query<SchemeRow>('select id, cohort_id, current_version_id, revision from grading_schemes where cohort_id = $1 for update', [
          cohort.id,
        ])
      ).rows[0]
      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: adminId,
          operationKind: 'grading.stage_setting',
          requestId,
          fingerprint: sha256(canonicalJson({ cohortId: cohort.id, stageKey, itemId, description, panelKey })),
          scope: 'cohort',
          cohortId: cohort.id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<StageSetting>(begun)
      if (cohort.status === 'archived') return archived(cohort)
      if (!scheme?.current_version_id) return noPublishedScheme()
      const stages = await versionStages(tx, scheme.current_version_id)
      const stage = stageOf(stages, stageKey)
      if (!stage) return err('VALIDATION_FAILED', '目前的評分規則沒有這個評分項目，請重新整理頁面。')

      // 對應作業：同屆、收件（作業）、整組一份、已發布（非草稿）、不是同意書、沒刪除（設計方案① §1.3）。
      let itemTitle: string | null = null
      if (itemId) {
        const item = (
          await tx.query<ItemRow>(
            `select id, title, cohort_id, placement, receiver_unit, status, consent_mode, deleted_at from managed_items where id = $1`,
            [itemId],
          )
        ).rows[0]
        const usable =
          !!item &&
          item.cohort_id === cohort.id &&
          (item.placement === 'submission' || item.placement === 'requirement') &&
          item.receiver_unit === 'group' &&
          item.status !== 'draft' &&
          item.consent_mode === null &&
          item.deleted_at === null
        if (!usable) {
          return err('VALIDATION_FAILED', '對應作業要選這一屆已發布、整組繳交的作業（不能是同意書）；請重新整理頁面再選。', {
            details: { field: 'itemId' },
          })
        }
        itemTitle = item.title
      }

      // 評審組：同屆已有別的項目用同一個 panelKey 時，先驗每一組這些項目的評審一致（不自動補、不結束任何指派）。
      if (panelKey !== null) {
        const others = await tx.query<{ stage_key: string }>(
          'select stage_key from grading_stage_settings where cohort_id = $1 and panel_key = $2 and stage_key <> $3',
          [cohort.id, panelKey, stage.key],
        )
        const keys = [stage.key, ...others.rows.map((r) => r.stage_key).filter((k) => stageOf(stages, k))].sort()
        if (keys.length > 1) {
          const groups = await panelFacts(tx, cohort.id, keys)
          const mismatched = panelMismatches(keys, groups)
          if (mismatched.length > 0) {
            return err('VALIDATION_FAILED', describePanelMismatch(mismatched, keys.map((k) => stageOf(stages, k)!.name)), {
              details: { field: 'panelKey', groups: mismatched },
            })
          }
        }
      }

      const cleared = itemId === null && description === null && panelKey === null
      if (cleared) {
        await tx.query('delete from grading_stage_settings where cohort_id = $1 and stage_key = $2', [cohort.id, stage.key])
      } else {
        await tx.query(
          `insert into grading_stage_settings (cohort_id, stage_key, item_id, description, panel_key, updated_by_user_id, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (cohort_id, stage_key) do update
             set item_id = excluded.item_id, description = excluded.description, panel_key = excluded.panel_key,
                 updated_by_user_id = excluded.updated_by_user_id, updated_at = excluded.updated_at`,
          [cohort.id, stage.key, itemId, description, panelKey, adminId, realAt],
        )
      }
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: adminId,
        role: 'admin',
        action: 'grading.stage_setting',
        targetType: 'cohort',
        targetId: cohort.id,
        scope: 'cohort',
        cohortId: cohort.id,
        realAt,
        businessAt: businessNow,
        payload: { stageKey: stage.key, itemId, description, panelKey, cleared },
      })
      const receipt: StageSetting = { stageKey: stage.key, itemId, itemTitle, description, panelKey }
      const full = { ...receipt, requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt: full, resultRef: { cohortId: cohort.id, stageKey: stage.key } })
      return { ok: true as const, receipt: full }
    })
  }
}

async function versionStages(db: Pick<PoolClient, 'query'>, versionId: string): Promise<SchemeStage[]> {
  const rows = await db.query<{ stages: unknown }>('select stages from grading_scheme_versions where id = $1', [versionId])
  return rows.rows[0] ? readSchemeStages(rows.rows[0].stages) : []
}

/** 評審組一致性要比的事實：本屆進行中每一組，在這些項目上的「要幾位老師評」與有效評分老師（3 句）。 */
async function panelFacts(tx: PoolClient, cohortId: string, keys: readonly string[]): Promise<PanelGroupFacts[]> {
  // 同一個交易連線上逐句查（pg 的 client 不能並行送查詢）。
  const groups = await tx.query<{ id: string; code: string }>(`select id, code from groups where cohort_id = $1 and status = 'active' order by code`, [
    cohortId,
  ])
  const requirements = await tx.query<{ group_id: string; stage_key: string; required_count: number }>(
    `select r.group_id, r.stage_key, r.required_count from stage_requirements r join groups g on g.id = r.group_id
      where g.cohort_id = $1 and r.stage_key = any($2::text[])`,
    [cohortId, keys],
  )
  const assignments = await tx.query<{ group_id: string; stage_key: string; teacher_user_id: string }>(
    `select a.group_id, a.stage_key, a.teacher_user_id from evaluator_assignments a join groups g on g.id = a.group_id
      where g.cohort_id = $1 and a.stage_key = any($2::text[]) and a.valid_to is null`,
    [cohortId, keys],
  )
  return groups.rows.map((g) => {
    const requiredByStage = new Map<string, number>()
    for (const r of requirements.rows) if (r.group_id === g.id) requiredByStage.set(r.stage_key, r.required_count)
    const teachersByStage = new Map<string, Set<string>>()
    for (const a of assignments.rows) {
      if (a.group_id !== g.id) continue
      const set = teachersByStage.get(a.stage_key) ?? new Set<string>()
      set.add(a.teacher_user_id)
      teachersByStage.set(a.stage_key, set)
    }
    return { groupId: g.id, groupCode: g.code, requiredByStage, teachersByStage }
  })
}

export class PgGradingStageSettingQuery implements GradingStageSettingQuery {
  readonly #reader: () => Pick<Pool, 'query'>

  constructor(reader: () => Pick<Pool, 'query'> = getPool) {
    this.#reader = reader
  }

  /** 1 句：側表 join 目前版本的項目（不在目前版本的列不讀）與對應作業標題。 */
  async stageSettings(actor: ResolvedActor, cohortId: string): Promise<Result<readonly StageSetting[]>> {
    const denied = authorizeAdmin(actor, '查看評分規則')
    if (denied) return denied
    if (!isUuid(cohortId)) return err('VALIDATION_FAILED', '找不到這個屆別，請重新整理頁面。')
    const rows = await this.#reader().query<{
      stage_key: string
      item_id: string | null
      item_title: string | null
      description: string | null
      panel_key: string | null
    }>(
      `select gss.stage_key, gss.item_id, m.title as item_title, gss.description, gss.panel_key
         from grading_stage_settings gss
         join grading_schemes s on s.cohort_id = gss.cohort_id
         join grading_scheme_versions v on v.id = s.current_version_id
         left join managed_items m on m.id = gss.item_id
        where gss.cohort_id = $1
          and exists (select 1 from jsonb_array_elements(v.stages) st where st->>'key' = gss.stage_key)
        order by gss.stage_key`,
      [cohortId],
    )
    return okList(
      rows.rows.map((r) => ({
        stageKey: r.stage_key,
        itemId: r.item_id,
        itemTitle: r.item_title,
        description: r.description,
        panelKey: r.panel_key,
      })),
    )
  }
}
