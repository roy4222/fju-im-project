import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { uuidv7 } from 'uuidv7'
import {
  analyzeRoster,
  pickCohort,
  ROSTER_MAX_BYTES,
  rosterAccessDenied,
  type CohortOption,
  type ResolvedActor,
  type RosterAnalysis,
  type RosterCommand,
  type RosterCounts,
  type RosterImportReceipt,
  type RosterPreview,
  type RosterUploadTicket,
  type RosterVersionRow,
} from '@/application/accounts'
import {
  canonicalJson,
  type AuditWriter,
  type FileStorage,
  type OperationLedger,
  type StoredFileContent,
  type UploadRules,
} from '@/application/ops'
import { defaultNextStep, type ErrorCode } from '@/shared/errors'
import { err, ok, type Err, type Result } from '@/shared/result'
import { RealClock, type Clock } from '@/shared/time'
import { sha256 } from '@/infrastructure/ops/audit-writer'

/**
 * 名單匯入（模組 01 §5 `RosterCommand`、§6「名單匯入整批一交易」；案例 ACC-01）。
 *
 * 1. `startUpload`：管理員拿一張只能傳 CSV、最多 2 MiB 的上傳 ticket（共用檔案能力）。
 * 2. `preview`：讀**已存的原檔**分析，不寫任何名單資料。
 * 3. `importRoster`：再讀一次同一份原檔、用同一個函式分析，一個交易寫完
 *    `roster_versions`＋`roster_entries`＋原檔引用＋稽核＋帳本。任何一步失敗整批回滾。
 *
 * 預覽與匯入都從伺服器上那份原檔重新分析，不信瀏覽器傳回來的預覽結果；
 * 原檔有 checksum 而且不可改，所以「預覽看到的」就是「匯入的」。
 */

export const ROSTER_UPLOAD_RULES: UploadRules = {
  purpose: 'roster_csv',
  allowedTypes: ['csv'],
  maxBytes: ROSTER_MAX_BYTES,
  scope: { kind: 'global' },
}

/** 預覽只回前幾列給畫面看樣子；完整的列只在伺服器端。 */
const PREVIEW_SAMPLE_ROWS = 20
const PREVIEW_MAX_ISSUES = 200
/** `roster_versions.summary` 裡最多留幾筆問題（行號＋原因），其餘只留計數。 */
const SUMMARY_MAX_ISSUES = 500

export type RosterCommandDeps = {
  readonly files: FileStorage<PoolClient>
  readonly audit: AuditWriter<PoolClient>
  readonly ledger: OperationLedger<PoolClient>
  readonly db: () => Pool
  readonly clock?: Clock
}

function meta(now: Date, requestId = uuidv7()) {
  return { requestId, serverTime: now.toISOString() }
}

function denied(code: ErrorCode): Err {
  const messages: Partial<Record<ErrorCode, string>> = {
    UNAUTHENTICATED: '請先登入。',
    FORBIDDEN: '只有系辦可以匯入名單。',
    PASSWORD_CHANGE_REQUIRED: '請先修改密碼。',
    ACCOUNT_PENDING: '帳號還在審核中。',
  }
  return err(code, messages[code] ?? '無法執行這個動作。', { next: defaultNextStep(code) })
}

type RosterSummary = {
  counts: RosterCounts
  columns: RosterAnalysis['columns']
  fileName: string
  checksum: string
  issues: RosterAnalysis['issues']
  issuesTotal: number
}

export class PgRosterCommand implements RosterCommand {
  readonly #deps: RosterCommandDeps
  readonly #clock: Clock

  constructor(deps: RosterCommandDeps) {
    this.#deps = deps
    this.#clock = deps.clock ?? new RealClock()
  }

  async startUpload(
    actor: ResolvedActor,
    input: { fileName: string; declaredMime: string; declaredSize: number },
  ): Promise<Result<RosterUploadTicket>> {
    const blocked = rosterAccessDenied(actor)
    if (blocked || actor.kind !== 'authenticated') return denied(blocked ?? 'UNAUTHENTICATED')
    const issued = await this.#deps.files.issueUploadTicket(actor.userId, input, ROSTER_UPLOAD_RULES)
    if (!issued.ok) return issued
    const { ticket, fileId, maxBytes, expiresAt } = issued.receipt
    return ok({ ticket, fileId, maxBytes, expiresAt }, meta(this.#clock.now()))
  }

  async preview(actor: ResolvedActor, input: { fileId: string; cohortId: string | null }): Promise<Result<RosterPreview>> {
    const blocked = rosterAccessDenied(actor)
    if (blocked || actor.kind !== 'authenticated') return denied(blocked ?? 'UNAUTHENTICATED')

    const loaded = await this.#load(actor.userId, input.fileId)
    if (!loaded.ok) return loaded
    const { file, text, cohorts } = loaded

    const first = analyzeRoster(text, cohorts, null)
    if (!first.ok) return err('VALIDATION_FAILED', first.message)
    const selectedCohortId = pickCohort(input.cohortId, first.analysis.suggestedCohortId, cohorts)
    const analyzed = selectedCohortId ? analyzeRoster(text, cohorts, selectedCohortId) : first
    if (!analyzed.ok) return err('VALIDATION_FAILED', analyzed.message)
    const { analysis } = analyzed

    return ok(
      {
        fileId: file.fileId,
        fileName: file.originalName,
        checksum: file.checksum,
        columns: analysis.columns,
        counts: analysis.counts,
        issues: analysis.issues.slice(0, PREVIEW_MAX_ISSUES),
        issuesTruncated: analysis.issues.length > PREVIEW_MAX_ISSUES,
        sample: analysis.entries.slice(0, PREVIEW_SAMPLE_ROWS).map((e) => ({
          line: e.line,
          studentNo: e.studentNo,
          nameRaw: e.nameRaw,
          departmentClass: e.departmentClass,
          email: e.email,
          cohortRaw: e.cohortRaw,
        })),
        cohorts,
        cohortValues: analysis.cohortValues,
        selectedCohortId,
      },
      meta(this.#clock.now()),
    )
  }

  async importRoster(
    actor: ResolvedActor,
    input: { fileId: string; cohortId: string; requestId: string },
  ): Promise<Result<RosterImportReceipt>> {
    const blocked = rosterAccessDenied(actor)
    if (blocked || actor.kind !== 'authenticated') return denied(blocked ?? 'UNAUTHENTICATED')
    if (!input.requestId || input.requestId.length > 100) return err('VALIDATION_FAILED', '請求編號不正確，請重新整理。')

    const loaded = await this.#load(actor.userId, input.fileId)
    if (!loaded.ok) return loaded
    const { file, text, cohorts } = loaded

    const cohort = cohorts.find((c) => c.id === input.cohortId)
    if (!cohort) return err('VALIDATION_FAILED', '請選擇一個既有的屆別。')

    const analyzed = analyzeRoster(text, cohorts, cohort.id)
    if (!analyzed.ok) return err('VALIDATION_FAILED', analyzed.message)
    const { analysis } = analyzed
    if (analysis.counts.valid === 0) return err('VALIDATION_FAILED', '這份名單沒有任何可以匯入的學生。')

    const now = this.#clock.now()
    const fingerprint = sha256(canonicalJson({ fileId: file.fileId, checksum: file.checksum, cohortId: cohort.id }))
    const tx = await this.#deps.db().connect()
    try {
      await tx.query('begin')
      const begun = await this.#deps.ledger.begin(
        tx,
        {
          actorUserId: actor.userId,
          operationKind: 'roster.import',
          requestId: input.requestId,
          fingerprint,
          scope: 'cohort',
          cohortId: cohort.id,
        },
        now,
      )
      if (begun.outcome === 'mismatch') {
        await tx.query('rollback')
        return err('REQUEST_MISMATCH', '這個請求編號已經用在別的匯入上，請重新整理後再試。')
      }
      if (begun.outcome === 'replay') {
        await tx.query('commit')
        if (begun.receiptExpired) return err('RECEIPT_EXPIRED', '這次匯入已經完成，回執已過期；請看名單版本列表。')
        return ok(begun.receipt as RosterImportReceipt, meta(now, input.requestId))
      }

      const versionId = uuidv7()
      const summary: RosterSummary = {
        counts: analysis.counts,
        columns: analysis.columns,
        fileName: file.originalName,
        checksum: file.checksum,
        issues: analysis.issues.slice(0, SUMMARY_MAX_ISSUES),
        issuesTotal: analysis.issues.length,
      }
      await tx.query(
        `insert into roster_versions (id, cohort_id, imported_by_user_id, imported_real_at, summary, file_id)
         values ($1, $2, $3, $4, $5::jsonb, $6)`,
        [versionId, cohort.id, actor.userId, now, JSON.stringify(summary), file.fileId],
      )

      // 只有乾淨的列進 roster_entries；重複、缺欄、衝突列記在 summary（附行號），不匯入。
      const entries = analysis.entries
      await tx.query(
        `insert into roster_entries
           (id, roster_version_id, student_no, name_raw, name_normalized, department_class, email)
         select id, $2, student_no, name_raw, name_normalized, department_class, email
           from unnest($1::uuid[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
             as t(id, student_no, name_raw, name_normalized, department_class, email)`,
        [
          entries.map(() => uuidv7()),
          versionId,
          entries.map((e) => e.studentNo),
          entries.map((e) => e.nameRaw),
          entries.map((e) => e.nameNormalized),
          entries.map((e) => e.departmentClass),
          entries.map((e) => e.email),
        ],
      )

      const attached = await this.#deps.files.attach(
        tx,
        file.fileId,
        { refType: 'roster_version', refId: versionId },
        { ownerUserId: actor.userId, purpose: 'roster_csv' },
      )
      if (!attached.ok) {
        await tx.query('rollback')
        return attached
      }

      await this.#deps.audit.append(tx, {
        actorKind: 'user',
        actorUserId: actor.userId,
        role: 'admin',
        action: 'roster.import',
        targetType: 'roster_version',
        targetId: versionId,
        scope: 'cohort',
        cohortId: cohort.id,
        realAt: now,
        businessAt: now,
        payload: { fileId: file.fileId, checksum: file.checksum, counts: analysis.counts },
      })

      const receipt: RosterImportReceipt = {
        rosterVersionId: versionId,
        cohortId: cohort.id,
        cohortName: cohort.name,
        counts: analysis.counts,
        importedAt: now.toISOString(),
      }
      await this.#deps.ledger.commit(tx, begun.recordId, { receipt, resultRef: { rosterVersionId: versionId } })
      await tx.query('commit')
      return ok(receipt, meta(now, input.requestId))
    } catch (error) {
      await tx.query('rollback').catch(() => undefined)
      throw error
    } finally {
      tx.release()
    }
  }

  async listVersions(actor: ResolvedActor): Promise<Result<{ versions: readonly RosterVersionRow[] }>> {
    const blocked = rosterAccessDenied(actor)
    if (blocked || actor.kind !== 'authenticated') return denied(blocked ?? 'UNAUTHENTICATED')

    const rows = await this.#deps.db().query<{
      id: string
      cohort_code: string
      cohort_name: string
      imported_by: string
      imported_real_at: Date
      summary: RosterSummary
      file_id: string | null
      file_name: string | null
    }>(
      `select rv.id, c.code as cohort_code, c.name as cohort_name,
              coalesce(up.display_name, u.name) as imported_by,
              rv.imported_real_at, rv.summary, rv.file_id, sf.original_name as file_name
         from roster_versions rv
         join cohorts c on c.id = rv.cohort_id
         join users u on u.id = rv.imported_by_user_id
         left join user_profiles up on up.user_id = u.id
         left join stored_files sf on sf.id = rv.file_id
        order by rv.imported_real_at desc, rv.id desc
        limit 50`,
    )
    return ok(
      {
        versions: rows.rows.map((r) => ({
          id: r.id,
          cohortCode: r.cohort_code,
          cohortName: r.cohort_name,
          importedBy: r.imported_by,
          importedAt: new Date(r.imported_real_at).toISOString(),
          counts: r.summary.counts,
          fileId: r.file_id,
          fileName: r.file_name,
        })),
      },
      meta(this.#clock.now()),
    )
  }

  /** 讀原檔、解成文字、撈可選的屆別。 */
  async #load(
    userId: string,
    fileId: string,
  ): Promise<{ ok: true; file: StoredFileContent; text: string; cohorts: CohortOption[] } | Err> {
    const read = await this.#deps.files.readOwned(userId, fileId, 'roster_csv', ROSTER_MAX_BYTES)
    if (!read.ok) return read
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(read.receipt.bytes)
    } catch {
      return err('VALIDATION_FAILED', '檔案不是 UTF-8 編碼；請在 Excel 另存為「CSV UTF-8」再上傳。')
    }
    const cohorts = await this.#cohorts()
    return { ok: true, file: read.receipt, text, cohorts }
  }

  async #cohorts(): Promise<CohortOption[]> {
    const rows = await this.#deps.db().query<{
      id: string
      code: string
      name: string
      is_registration_open: boolean
      is_default_working: boolean
    }>(
      `select id, code, name, is_registration_open, is_default_working
         from cohorts where status <> 'archived'
        order by created_at desc, code desc`,
    )
    return rows.rows.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      isRegistrationOpen: r.is_registration_open,
      isDefaultWorking: r.is_default_working,
    }))
  }
}
