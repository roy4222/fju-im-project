import 'server-only'
import { uuidv7 } from 'uuidv7'
import type { Pool } from 'pg'
import { readSchemeStages, type PublicGradingQuery, type PublicGradingWeights } from '@/application/grading'
import { getPool } from '@/infrastructure/db/client'
import { isUuid } from '@/infrastructure/grading/pg-grading'
import { ok, type Result } from '@/shared/result'

/**
 * 前台 /rules「評分方式」區塊（C 階段 C1-04、X7；設計方案① §7.5）：一屆目前已發布方案的評分項目、比例、說明、細項。
 *
 * 訪客可讀，所以只回方案結構與系辦寫給大家看的說明，**沒有任何分數、指派或組別**。
 * 1 句：屆別 × 方案頭列 × 目前版本，說明從側表帶（只認目前版本有的項目）。沒有已發布方案、屆別不存在 → `weights: null`。
 */
export class PgPublicGradingQuery implements PublicGradingQuery {
  readonly #reader: () => Pick<Pool, 'query'>

  constructor(reader: () => Pick<Pool, 'query'> = getPool) {
    this.#reader = reader
  }

  async weights(cohortId: string): Promise<Result<{ readonly weights: PublicGradingWeights | null }>> {
    const meta = { requestId: uuidv7(), serverTime: new Date().toISOString() }
    if (!isUuid(cohortId)) return ok({ weights: null }, meta)
    const row = (
      await this.#reader().query<{ cohort_name: string; stages: unknown; descriptions: Record<string, string> | null }>(
        `select c.name as cohort_name, v.stages,
                (select jsonb_object_agg(gss.stage_key, gss.description) from grading_stage_settings gss
                  where gss.cohort_id = c.id and gss.description is not null) as descriptions
           from cohorts c
           join grading_schemes s on s.cohort_id = c.id
           join grading_scheme_versions v on v.id = s.current_version_id
          where c.id = $1`,
        [cohortId],
      )
    ).rows[0]
    if (!row) return ok({ weights: null }, meta)
    const descriptions = row.descriptions ?? {}
    const stages = readSchemeStages(row.stages)
    if (stages.length === 0) return ok({ weights: null }, meta)
    return ok(
      {
        weights: {
          cohortName: row.cohort_name,
          stages: stages.map((st) => ({
            name: st.name,
            weight: st.weight,
            description: descriptions[st.key] ?? null,
            items: st.items.map((i) => ({ name: i.name, weight: i.weight, type: i.type })),
          })),
        },
      },
      meta,
    )
  }
}
