import 'server-only'
import { uuidv7 } from 'uuidv7'
import type { Pool, PoolClient } from 'pg'
import type { ResolvedActor } from '@/application/accounts'
import type { BusinessClockSource, CohortStatus } from '@/application/cohorts'
import {
  analyzeGroupImportCsv,
  GROUP_IMPORT_MAX_BYTES,
  isUuid,
  normalizeImportCode,
  planGroupImport,
  type GroupCommand,
  type GroupImportCommand,
  type GroupImportCreatePlan,
  type GroupImportInput,
  type GroupImportLookup,
  type GroupImportPreview,
  type GroupImportReceipt,
  type GroupImportRow,
  type GroupImportRowResult,
  type GroupImportUploadTicket,
  type ImportGroupFact,
  type ImportStudentFact,
} from '@/application/groups'
import type { EventPublisher } from '@/application/notifications'
import { canonicalJson, type AuditWriter, type FileStorage, type OperationLedger, type UploadRules } from '@/application/ops'
import { authorizeAdmin, badRequestId, inTransaction, replayed, type PoolSource } from '@/infrastructure/cohorts/shared'
import { getPool } from '@/infrastructure/db/client'
import { personName } from '@/infrastructure/db/person-name'
import { sha256 } from '@/infrastructure/ops/audit-writer'
import { err, ok, type Err, type Result } from '@/shared/result'
import { RealClock, type Clock } from '@/shared/time'

/**
 * 系辦匯入分組（C3-16；設計方案③ §6.4）。
 *
 * - 原檔走共用檔案能力的上傳 ticket（同批次指派指導老師：`advisor_csv` 用途、只收 CSV、≤ 256 KB）。
 *   `stored_files.purpose` 的白名單是資料庫 CHECK，加新用途要 migration（本票範圍外），所以沿用同一個「系辦批次 CSV」用途。
 * - 預覽與執行都重新讀同一份原檔、用 `analyzeGroupImportCsv` 分析；伺服器不信瀏覽器傳回來的預覽。
 * - 建新組：每組一個交易，管理員直接成組（`groups.created_by_kind='user'`、建立者是系辦、不經建立流程、不發邀請），
 *   全組收既有「成組」通知（`group.established`）。交易裡逐人再查一次；被別人搶先的那位寫「沒有成功」，其他人照建。
 * - 加人：每列走既有 `GroupCommand.addMember`（理由「名單匯入」），所以簽核失效 hook、`group.members_changed`、稽核都和手動加人一樣。
 * - 冪等：每一列的請求編號由批次編號推出來；整批的結果另記一筆帳本（`group.import`），同一個請求編號重送回第一次的結果。
 */

export const GROUP_IMPORT_UPLOAD_RULES: UploadRules = {
  purpose: 'advisor_csv',
  allowedTypes: ['csv'],
  maxBytes: GROUP_IMPORT_MAX_BYTES,
  scope: { kind: 'global' },
}

const IMPORT_REASON = '名單匯入'

type CohortRow = { id: string; code: string; status: CohortStatus; group_size_max: number }

type Deps = {
  audit: AuditWriter<PoolClient>
  ledger: OperationLedger<PoolClient>
  events: EventPublisher<PoolClient>
  files: FileStorage<PoolClient>
  businessClock: BusinessClockSource
  /** 加人走既有用例（含簽核失效 hook）。 */
  groups: GroupCommand
  pool?: PoolSource
  realClock?: Clock
}

/** 同一個批次請求裡每一步的請求編號：由批次編號與步驟鍵決定，重送整批時每一步都會重播而不是再做一次。 */
function stepRequestId(batchRequestId: string, key: string): string {
  const h = sha256(`${batchRequestId}:${key}`)
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

function rowResult(row: GroupImportRow, outcome: GroupImportRowResult['outcome'], message: string): GroupImportRowResult {
  return { line: row.line, studentNo: row.studentNo, groupCode: row.groupCode, studentName: row.studentName, outcome, message }
}

type CreateReceipt = { code: string; groupId: string | null; results: GroupImportRowResult[] }

export class PgGroupImportCommand implements GroupImportCommand {
  readonly #audit: AuditWriter<PoolClient>
  readonly #ledger: OperationLedger<PoolClient>
  readonly #events: EventPublisher<PoolClient>
  readonly #files: FileStorage<PoolClient>
  readonly #businessClock: BusinessClockSource
  readonly #groups: GroupCommand
  readonly #pool: PoolSource
  readonly #realClock: Clock

  constructor(deps: Deps) {
    this.#audit = deps.audit
    this.#ledger = deps.ledger
    this.#events = deps.events
    this.#files = deps.files
    this.#businessClock = deps.businessClock
    this.#groups = deps.groups
    this.#pool = deps.pool ?? getPool
    this.#realClock = deps.realClock ?? new RealClock()
  }

  async startUpload(
    actor: ResolvedActor,
    input: { fileName: string; declaredMime: string; declaredSize: number },
  ): Promise<Result<GroupImportUploadTicket>> {
    const denied = authorizeAdmin(actor, '匯入分組')
    if (denied || actor.kind !== 'authenticated') return denied ?? err('UNAUTHENTICATED', '請先登入。')
    const issued = await this.#files.issueUploadTicket(actor.userId, input, GROUP_IMPORT_UPLOAD_RULES)
    if (!issued.ok) return issued
    const { ticket, fileId, maxBytes, expiresAt } = issued.receipt
    return ok({ ticket, fileId, maxBytes, expiresAt }, { requestId: uuidv7(), serverTime: this.#realClock.now().toISOString() })
  }

  async preview(actor: ResolvedActor, input: GroupImportInput): Promise<Result<GroupImportPreview>> {
    const denied = authorizeAdmin(actor, '匯入分組')
    if (denied || actor.kind !== 'authenticated') return denied ?? err('UNAUTHENTICATED', '請先登入。')
    const loaded = await this.#load(actor.userId, input)
    if (!loaded.ok) return loaded
    const analyzed = analyzeGroupImportCsv(loaded.text, loaded.lookup)
    if (!analyzed.ok) return err('VALIDATION_FAILED', analyzed.message)
    return ok(
      {
        fileId: loaded.fileId,
        fileName: loaded.fileName,
        cohortId: loaded.cohort.id,
        rows: analyzed.analysis.rows,
        counts: analyzed.analysis.counts,
      },
      { requestId: uuidv7(), serverTime: this.#realClock.now().toISOString() },
    )
  }

  async execute(actor: ResolvedActor, input: GroupImportInput, requestId: string): Promise<Result<GroupImportReceipt>> {
    const denied = authorizeAdmin(actor, '匯入分組')
    if (denied || actor.kind !== 'authenticated') return denied ?? err('UNAUTHENTICATED', '請先登入。')
    if (!isUuid(requestId)) return badRequestId()
    const adminId = actor.userId

    // 同一個請求編號已經做完：回第一次的結果（不重新分析——那時的新組現在都「已在這組」了）。
    const previous = await this.#ledger.get(adminId, 'group.import', requestId)
    if (previous.outcome === 'replay') return replayed<GroupImportReceipt>(previous)

    const loaded = await this.#load(adminId, input)
    if (!loaded.ok) return loaded
    const analyzed = analyzeGroupImportCsv(loaded.text, loaded.lookup)
    if (!analyzed.ok) return err('VALIDATION_FAILED', analyzed.message)
    const plan = planGroupImport(analyzed.analysis)

    const results: GroupImportRowResult[] = plan.skipped.map((row) => rowResult(row, 'skipped', row.message))
    let createdGroups = 0
    for (const create of plan.creates) {
      const done = await this.#createGroup(adminId, loaded.cohort.id, create, requestId)
      if (done.ok) {
        if (done.receipt.groupId) createdGroups += 1
        results.push(...done.receipt.results)
      } else {
        results.push(...create.rows.map((row) => rowResult(row, 'failed', done.message)))
      }
    }
    for (const row of plan.adds) results.push(await this.#addRow(actor, loaded.lookup, row, requestId))
    results.sort((a, b) => a.line - b.line)

    const count = (outcome: GroupImportRowResult['outcome']) => results.filter((r) => r.outcome === outcome).length
    const receipt: GroupImportReceipt = {
      cohortId: loaded.cohort.id,
      fileName: loaded.fileName,
      results,
      createdGroups,
      added: count('added'),
      skipped: count('skipped'),
      failed: count('failed'),
    }

    // 整批一筆稽核＋帳本（每一列另有自己的建組／加人稽核）。
    const realAt = this.#realClock.now()
    const businessAt = await this.#businessClock.now()
    const recorded = await inTransaction(this.#pool, 'group-import', async (tx) => {
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: adminId,
          operationKind: 'group.import',
          requestId,
          fingerprint: sha256(canonicalJson({ fileId: loaded.fileId, cohortId: loaded.cohort.id })),
          scope: 'cohort',
          cohortId: loaded.cohort.id,
        },
        realAt,
      )
      // 兩個分頁同時送同一個請求編號：後到的拿先寫好的那份。
      if (begun.outcome !== 'fresh') return replayed<GroupImportReceipt>(begun)
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: adminId,
        role: 'admin',
        action: 'group.import',
        targetType: 'cohort',
        targetId: loaded.cohort.id,
        scope: 'cohort',
        cohortId: loaded.cohort.id,
        realAt,
        businessAt,
        payload: {
          fileId: loaded.fileId,
          checksum: loaded.checksum,
          requestId,
          createdGroups,
          added: receipt.added,
          skipped: receipt.skipped,
          failed: receipt.failed,
        },
      })
      const full = { ...receipt, requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt: full, resultRef: { cohortId: loaded.cohort.id } })
      return { ok: true as const, receipt: full }
    })
    return recorded
  }

  /** 加一位到既有組：當下的版本號、既有 `addMember`（每列自己的交易與請求編號）。 */
  async #addRow(actor: ResolvedActor, lookup: GroupImportLookup, row: GroupImportRow, batchRequestId: string): Promise<GroupImportRowResult> {
    const group = lookup.groupsByCode.get(row.groupCode)!
    const db = await this.#pool().connect()
    let revision: number | undefined
    try {
      revision = (await db.query<{ revision: number }>('select revision from groups where id = $1', [group.id])).rows[0]?.revision
    } finally {
      db.release()
    }
    if (revision === undefined) return rowResult(row, 'failed', `找不到 ${row.groupCode}，請重新預覽。`)
    const added = await this.#groups.addMember(
      actor,
      { groupId: group.id, revision, studentNo: row.studentNo, reason: IMPORT_REASON },
      stepRequestId(batchRequestId, `add:${row.line}:${row.studentNo}`),
    )
    return added.ok ? rowResult(row, 'added', `已加入 ${row.groupCode}`) : rowResult(row, 'failed', added.message)
  }

  /** 建一組（自己一個交易）：管理員直接成組，組長是第一位還能加入的人。 */
  async #createGroup(
    adminId: string,
    cohortId: string,
    plan: GroupImportCreatePlan,
    batchRequestId: string,
  ): Promise<Result<CreateReceipt>> {
    const businessNow = await this.#businessClock.now()
    const requestId = stepRequestId(batchRequestId, `create:${plan.code}`)
    return inTransaction(this.#pool, 'group-import', async (tx) => {
      const cohort = await tx.query<CohortRow>('select id, code, status, group_size_max from cohorts where id = $1 for share', [cohortId])
      if (!cohort.rows[0]) return err('VALIDATION_FAILED', '找不到這個屆別，請重新整理頁面。')
      if (cohort.rows[0].status === 'archived') return err('COHORT_ARCHIVED', '這一屆已封存，分組資料只能查看。')

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: adminId,
          operationKind: 'group.establish',
          requestId,
          fingerprint: sha256(canonicalJson({ cohortId, code: plan.code, studentNos: plan.rows.map((r) => r.studentNo) })),
          scope: 'cohort',
          cohortId,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<CreateReceipt>(begun)

      // 同一屆的組別代碼排隊配（和提案成立同一把鎖），學生鎖和加人、發起提案同一把。
      await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`groups.code:${cohortId}`])
      const done = async (receipt: CreateReceipt) => {
        await this.#ledger.commit(tx, begun.recordId, { receipt: { ...receipt, requestId, serverTime: realAt.toISOString() }, resultRef: { groupId: receipt.groupId } })
        return ok(receipt, { requestId, serverTime: realAt.toISOString() })
      }
      const taken = await tx.query('select 1 from groups where cohort_id = $1 and code = $2', [cohortId, plan.code])
      if (taken.rows[0]) {
        return done({ code: plan.code, groupId: null, results: plan.rows.map((row) => rowResult(row, 'failed', `剛剛有人建了 ${plan.code}，請重新預覽。`)) })
      }

      const students = await tx.query<{ student_no: string; user_id: string }>(
        `select si.student_no, si.user_id
           from student_identities si
           join users u on u.id = si.user_id
          where si.cohort_id = $1 and si.student_no = any($2::text[])
            and u.status = 'active' and u.deidentified_at is null
            and exists (select 1 from role_assignments r
                         where r.user_id = u.id and r.role = 'student' and r.revoked_real_at is null)`,
        [cohortId, plan.rows.map((r) => r.studentNo)],
      )
      const userOf = new Map(students.rows.map((s) => [s.student_no, s.user_id]))
      for (const id of [...new Set(userOf.values())].sort()) {
        await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`groups.student:${id}`])
      }
      const busy = await tx.query<{ user_id: string; code: string | null }>(
        `select m.user_id, g.code from group_memberships m join groups g on g.id = m.group_id
          where m.cohort_id = $1 and m.valid_to is null and m.user_id = any($2::uuid[])
         union all
         select o.user_id, null from proposal_occupancy o
           join group_proposals gp on gp.id = o.proposal_id
          where o.user_id = any($2::uuid[]) and gp.state = 'open' and gp.expires_business_at > $3`,
        [cohortId, [...userOf.values()], businessNow],
      )
      const busyOf = new Map(busy.rows.map((b) => [b.user_id, b.code]))

      const results: GroupImportRowResult[] = []
      const members: { row: GroupImportRow; userId: string }[] = []
      for (const row of plan.rows) {
        const userId = userOf.get(row.studentNo)
        if (!userId) results.push(rowResult(row, 'failed', '不在本屆名單（或帳號已停用）'))
        else if (busyOf.has(userId)) {
          const code = busyOf.get(userId)
          results.push(rowResult(row, 'failed', code ? `已在 ${code}` : '在建立中的組別裡，請先終止'))
        } else members.push({ row, userId })
      }
      if (members.length === 0) return done({ code: plan.code, groupId: null, results })

      const groupId = uuidv7()
      const leader = members[0]!
      const everyone = members.map((m) => m.userId)
      await tx.query(
        `insert into groups
           (id, cohort_id, code, group_type, status, established_real_at, established_business_at,
            created_at, created_by_kind, created_by_user_id, updated_at, updated_by_user_id)
         values ($1, $2, $3, $4, 'active', $5, $6, $5, 'user', $7, $5, $7)`,
        [groupId, cohortId, plan.code, plan.groupType, realAt, businessNow, adminId],
      )
      await tx.query(
        `insert into group_memberships
           (id, group_id, cohort_id, user_id, valid_from, added_by_kind, added_by_user_id, created_at, updated_at)
         select gen_random_uuid(), $1, $2, u, $3, 'user', $4, $5, $5 from unnest($6::uuid[]) as u`,
        [groupId, cohortId, businessNow, adminId, realAt, everyone],
      )
      await tx.query(
        `insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id, created_at)
         values ($1, $2, $3, $4, $5, $6)`,
        [uuidv7(), groupId, leader.userId, businessNow, adminId, realAt],
      )
      await this.#events.publish(tx, {
        type: 'group.established',
        scope: 'cohort',
        cohortId,
        source: { type: 'group', id: groupId, version: 1 },
        actor: { kind: 'user', userId: adminId },
        recipients: everyone,
        recipientBasis: { groupId, basis: 'group_memberships', source: 'import' },
        payload: { title: `組別 ${plan.code} 成立了`, groupId, code: plan.code },
        occurredRealAt: realAt,
        occurredBusinessAt: businessNow,
      })
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: adminId,
        role: 'admin',
        action: 'group.establish',
        targetType: 'group',
        targetId: groupId,
        scope: 'cohort',
        cohortId,
        reason: IMPORT_REASON,
        realAt,
        businessAt: businessNow,
        payload: { code: plan.code, source: 'import', groupType: plan.groupType, memberUserIds: everyone, leaderUserId: leader.userId },
      })
      for (const m of members) {
        results.push(rowResult(m.row, 'created', m === leader ? `已建 ${plan.code}・組長` : `已建 ${plan.code}`))
      }
      return done({ code: plan.code, groupId, results })
    })
  }

  /** 讀原檔、解成文字、撈這一屆的學生與組別（分析用）。 */
  async #load(
    adminId: string,
    input: GroupImportInput,
  ): Promise<{ ok: true; text: string; fileId: string; fileName: string; checksum: string; cohort: CohortRow; lookup: GroupImportLookup } | Err> {
    if (!isUuid(String(input?.fileId ?? ''))) return err('VALIDATION_FAILED', '請先上傳 CSV 檔。')
    if (!isUuid(String(input?.cohortId ?? ''))) return err('VALIDATION_FAILED', '請先選屆別。')
    const read = await this.#files.readOwned(adminId, input.fileId, 'advisor_csv', GROUP_IMPORT_MAX_BYTES)
    if (!read.ok) return read
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(read.receipt.bytes)
    } catch {
      return err('VALIDATION_FAILED', '檔案不是 UTF-8 編碼；請在 Excel 另存為「CSV UTF-8」再上傳。')
    }
    const db = await this.#pool().connect()
    try {
      const cohort = await db.query<CohortRow>('select id, code, status, group_size_max from cohorts where id = $1', [input.cohortId])
      if (!cohort.rows[0]) return err('VALIDATION_FAILED', '找不到這個屆別，請重新整理頁面。')
      if (cohort.rows[0].status === 'archived') return err('COHORT_ARCHIVED', `${cohort.rows[0].code} 已封存，分組資料只能查看。`)
      return {
        ok: true,
        text,
        fileId: read.receipt.fileId,
        fileName: read.receipt.originalName,
        checksum: read.receipt.checksum,
        cohort: cohort.rows[0],
        lookup: await importLookup(db, cohort.rows[0], await this.#businessClock.now()),
      }
    } finally {
      db.release()
    }
  }
}

/**
 * 分析要的資料：這一屆已核准、帳號正常、目前是學生的人（含目前組別代碼、是否在建立中的組別裡），
 * 以及這一屆所有組別（含已刪除的，才能說清楚原因）與目前人數。過期還沒被收掉的建立中組別不算。
 */
async function importLookup(db: Pick<Pool, 'query'>, cohort: CohortRow, businessNow: Date): Promise<GroupImportLookup> {
  const students = await db.query<{
    student_no: string
    user_id: string
    name: string
    group_code: string | null
    proposal_id: string | null
    proposer_name: string | null
  }>(
    `select si.student_no, si.user_id, ${personName('p', 'u')} as name, g.code as group_code,
            gp.id as proposal_id, ${personName('pp', 'pu')} as proposer_name
       from student_identities si
       join users u on u.id = si.user_id
       left join user_profiles p on p.user_id = si.user_id
       left join group_memberships m on m.user_id = si.user_id and m.cohort_id = si.cohort_id and m.valid_to is null
       left join groups g on g.id = m.group_id
       left join proposal_occupancy o on o.user_id = si.user_id
       left join group_proposals gp on gp.id = o.proposal_id and gp.state = 'open' and gp.expires_business_at > $2
       left join users pu on pu.id = gp.proposer_user_id
       left join user_profiles pp on pp.user_id = gp.proposer_user_id
      where si.cohort_id = $1
        and u.status = 'active' and u.deidentified_at is null
        and exists (select 1 from role_assignments r
                     where r.user_id = u.id and r.role = 'student' and r.revoked_real_at is null)`,
    [cohort.id, businessNow],
  )
  const groups = await db.query<{ id: string; code: string; status: 'active' | 'dissolved'; member_count: number }>(
    `select g.id, g.code, g.status,
            (select count(*)::int from group_memberships m where m.group_id = g.id and m.valid_to is null) as member_count
       from groups g where g.cohort_id = $1`,
    [cohort.id],
  )
  return {
    studentsByNo: new Map<string, ImportStudentFact>(
      students.rows.map((s) => [
        s.student_no,
        { userId: s.user_id, name: s.name, groupCode: s.group_code, proposerName: s.proposal_id ? (s.proposer_name ?? '') : null },
      ]),
    ),
    groupsByCode: new Map<string, ImportGroupFact>(
      groups.rows.map((g) => [normalizeImportCode(g.code), { id: g.id, code: g.code, status: g.status, memberCount: g.member_count }]),
    ),
    sizeMax: cohort.group_size_max,
  }
}
