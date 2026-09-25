import 'server-only'
import { uuidv7 } from 'uuidv7'
import type { Pool, PoolClient } from 'pg'
import type { ResolvedActor } from '@/application/accounts'
import {
  buildGradeCsv,
  gradeExportHeader,
  gradeExportRows,
  selectExportGroups,
  type GradebookQuery,
  type GradeExporter,
  type GradeExportRequest,
  type GradeExportResult,
} from '@/application/grading'
import type { AuditWriter } from '@/application/ops'
import { authorizeAdmin } from '@/infrastructure/cohorts/shared'
import { getPool } from '@/infrastructure/db/client'
import { err, ok, type Result } from '@/shared/result'
import { RealClock, type Clock } from '@/shared/time'
import { buildXlsx } from '@/shared/xlsx'

/**
 * 整屆成績匯出 CSV／XLSX（票 24；產品 06 §4「7.6」、2026-09-15 定案補充／成績匯出；GRD-10）。
 *
 * 只有管理員；每次都從用例重新授權、重新查詢、重新算（`GradebookQuery.gradebook`：和畫面的成績表同一份計算），
 * 篩選也是同一個 `selectExportGroups`，所以筆數、兩位小數與更正後結果都和畫面一致。
 * 稽核只記範圍與筆數（不記姓名、學號與分數）。
 */
export class PgGradeExporter implements GradeExporter {
  readonly #query: GradebookQuery
  readonly #audit: AuditWriter<PoolClient>
  readonly #pool: () => Pick<Pool, 'connect'>
  readonly #clock: Clock

  constructor(deps: { query: GradebookQuery; audit: AuditWriter<PoolClient>; pool?: () => Pick<Pool, 'connect'>; clock?: Clock }) {
    this.#query = deps.query
    this.#audit = deps.audit
    this.#pool = deps.pool ?? getPool
    this.#clock = deps.clock ?? new RealClock()
  }

  async exportGrades(actor: ResolvedActor, request: GradeExportRequest): Promise<Result<GradeExportResult>> {
    const denied = authorizeAdmin(actor, '匯出成績')
    if (denied || actor.kind !== 'authenticated') return denied ?? err('UNAUTHENTICATED', '請先登入。')

    const book = await this.#query.gradebook(actor, request.cohortId)
    if (!book.ok) return book
    const { receipt } = book
    if (!receipt.version) return err('VALIDATION_FAILED', '這一屆還沒有評分方案，沒有成績可以匯出。')
    if (request.filter.stageKey !== 'all' && !receipt.version.stages.some((s) => s.key === request.filter.stageKey)) {
      return err('VALIDATION_FAILED', '目前的評分方案沒有這個階段，請重新整理頁面。')
    }
    const groups = selectExportGroups(receipt, request.filter)
    if (groups.length === 0) return err('VALIDATION_FAILED', '沒有符合的組別可以匯出。')

    const header = gradeExportHeader(receipt, groups, request.filter)
    const rows = gradeExportRows(receipt, groups, request.filter)
    const body = request.format === 'csv' ? buildGradeCsv(header, rows) : buildXlsx(`${receipt.cohort.code} 成績`, header, rows)
    const now = this.#clock.now()

    const tx = await this.#pool().connect()
    try {
      await tx.query('begin')
      await this.#audit.append(tx as PoolClient, {
        actorKind: 'user',
        actorUserId: actor.userId,
        role: 'admin',
        action: 'grading.export',
        targetType: 'gradebook',
        scope: 'cohort',
        cohortId: request.cohortId,
        realAt: now,
        businessAt: now,
        payload: {
          format: request.format,
          stageKey: request.filter.stageKey,
          groupId: request.filter.groupId,
          status: request.filter.status,
          versionNo: receipt.version.versionNo,
          groups: groups.length,
          rows: rows.length,
        },
      })
      await tx.query('commit')
    } catch (error) {
      await tx.query('rollback').catch(() => undefined)
      throw error
    } finally {
      tx.release()
    }

    return ok(
      { format: request.format, cohortCode: receipt.cohort.code, groupCount: groups.length, rowCount: rows.length, body },
      { requestId: uuidv7(), serverTime: now.toISOString() },
    )
  }
}
