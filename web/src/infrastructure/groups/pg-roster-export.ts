import 'server-only'
import { uuidv7 } from 'uuidv7'
import type { Pool, PoolClient } from 'pg'
import type { ResolvedActor } from '@/application/accounts'
import {
  applyRosterFilter,
  buildRosterCsv,
  ROSTER_EXPORT_COLUMNS,
  rosterExportRows,
  type GroupQuery,
  type GroupRosterExporter,
  type RosterExportRequest,
  type RosterExportResult,
} from '@/application/groups'
import type { AuditWriter } from '@/application/ops'
import { authorizeAdmin } from '@/infrastructure/cohorts/shared'
import { getPool } from '@/infrastructure/db/client'
import { err, ok, type Result } from '@/shared/result'
import { RealClock, type Clock } from '@/shared/time'
import { buildXlsx } from '@/shared/xlsx'

/**
 * 組別名單匯出（票 20；#105、C18）。
 *
 * 只有管理員；每次都從用例重新授權、重新查詢（`GroupQuery.overview`：所選屆別、有效的組別、管理員版含登入信箱）。
 * 「勾選的組別」只收這一屆的有效組；「篩選結果」用和畫面同一個 `applyRosterFilter`，筆數才會一致。
 * 稽核只記範圍與筆數（不記姓名、信箱與搜尋字）。
 */
export class PgGroupRosterExporter implements GroupRosterExporter {
  readonly #query: GroupQuery
  readonly #audit: AuditWriter<PoolClient>
  readonly #pool: () => Pick<Pool, 'connect' | 'query'>
  readonly #clock: Clock

  constructor(deps: {
    query: GroupQuery
    audit: AuditWriter<PoolClient>
    pool?: () => Pick<Pool, 'connect' | 'query'>
    clock?: Clock
  }) {
    this.#query = deps.query
    this.#audit = deps.audit
    this.#pool = deps.pool ?? getPool
    this.#clock = deps.clock ?? new RealClock()
  }

  async exportRoster(actor: ResolvedActor, request: RosterExportRequest): Promise<Result<RosterExportResult>> {
    const denied = authorizeAdmin(actor, '匯出組別名單')
    if (denied || actor.kind !== 'authenticated') return denied ?? err('UNAUTHENTICATED', '請先登入。')

    const cohort = await this.#pool().query<{ code: string }>('select code from cohorts where id = $1', [request.cohortId])
    const cohortCode = cohort.rows[0]?.code
    if (!cohortCode) return err('VALIDATION_FAILED', '找不到這個屆別，請重新整理頁面。')

    const { groups } = await this.#query.overview(request.cohortId)
    const selected =
      request.selection.kind === 'ids'
        ? applyRosterFilter(
            groups.filter((g) => (request.selection as { groupIds: readonly string[] }).groupIds.includes(g.id)),
            { type: 'all', status: 'all', advisor: 'all', q: '', sort: 'code', dir: 'asc' },
          )
        : applyRosterFilter(groups, request.selection.filter)
    if (selected.length === 0) return err('VALIDATION_FAILED', '沒有符合的組別可以匯出。')

    const rows = rosterExportRows(cohortCode, selected)
    const body = request.format === 'csv' ? buildRosterCsv(rows) : buildXlsx(`${cohortCode} 組別名單`, ROSTER_EXPORT_COLUMNS, rows)
    const now = this.#clock.now()

    const tx = await this.#pool().connect()
    try {
      await tx.query('begin')
      await this.#audit.append(tx as PoolClient, {
        actorKind: 'user',
        actorUserId: actor.userId,
        role: 'admin',
        action: 'group.export',
        targetType: 'group_roster',
        scope: 'cohort',
        cohortId: request.cohortId,
        realAt: now,
        businessAt: now,
        payload:
          request.selection.kind === 'ids'
            ? { kind: 'ids', format: request.format, requested: request.selection.groupIds.length, groups: selected.length, rows: rows.length }
            : {
                kind: 'filter',
                format: request.format,
                groups: selected.length,
                rows: rows.length,
                type: request.selection.filter.type,
                status: request.selection.filter.status,
                advisor: request.selection.filter.advisor,
                hasSearch: request.selection.filter.q.length > 0,
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
      { format: request.format, cohortCode, groupCount: selected.length, rowCount: rows.length, body },
      { requestId: uuidv7(), serverTime: now.toISOString() },
    )
  }
}
