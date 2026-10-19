import 'server-only'
import { uuidv7 } from 'uuidv7'
import type { PoolClient } from 'pg'
import type { ResolvedActor } from '@/application/accounts'
import { cohortLabel, type BusinessClockSource, type CohortStatus } from '@/application/cohorts'
import { reminderMail, type Mailer } from '@/application/mail'
import type { EventPublisher } from '@/application/notifications'
import { canonicalJson, type AuditWriter, type OperationLedger } from '@/application/ops'
import {
  cooldownEndsAt,
  cooldownMessage,
  gradingReminderTitle,
  itemReminderTitle,
  nextAllowedAt,
  pendingReceiverIds,
  teachersBehind,
  type LastReminded,
  type ReminderCommand,
  type ReminderQuery,
  type ReminderReceiver,
  type RemindGradingReceipt,
  type RemindItemReceipt,
  type RemindOverdueItem,
  type RemindOverdueReceipt,
} from '@/application/reminders'
import { buildProgress, readParticipants, remindRecipients, type SignoffState, type VoteRecord } from '@/application/signoff'
import { categoryOf, receiverStatus } from '@/application/submissions'
import { authorizeAdmin, badRequestId, cohortNotFound, inTransaction, replayed, type PoolSource } from '@/infrastructure/cohorts/shared'
import { getPool } from '@/infrastructure/db/client'
import { sha256 } from '@/infrastructure/ops/audit-writer'
import { receiverFactsJoin, REOPEN_UNTIL } from '@/infrastructure/submissions/pg-submissions'
import { err, ok, type Err, type Result } from '@/shared/result'
import { RealClock, type Clock } from '@/shared/time'

/**
 * 催繳（C 階段規格① §1.5、§3.5、§8；AC-12、AC-34 後端）。
 *
 * 一次催繳是一筆交易：鎖 → 帳本 `begin` → 冷卻 → 算收件人 → 事件（站內通知）→ 稽核 → 帳本 `commit`；
 * **commit 之後**才寄信（每位收件人一封，同時寄、全部結束才回；每封有逾時，失敗只留 `mail_outbox` 的 `failed`、不回滾、不回錯）。
 *
 * - 冷卻同 `signoff.remind`：查 `domain_events` 最後一筆 `item.reminded`（`source_type='item'`、`source_id`＝作業）／
 *   `grading.reminded`（`source_type='grading_cohort'`、`source_id`＝屆別）的真實時間。連按兩下由交易級 advisory lock 排隊
 *   （鍵＝作業或屆別），後到的那一下看得到前一下剛寫的事件，只會送出一次；不鎖 `managed_items` 列，不擋系辦同時改作業。
 * - 鎖順序：`cohorts FOR SHARE` → advisory lock（多份作業依 id 排序拿）。
 * - 收件人：口徑同名單頁（目前名單、不含免填與移出、還沒有正式版本；逾期用收件模組同一個 `receiverStatus`）。
 *   整組收件展開成該組此刻的有效組員；站內同意書看簽核包（還沒表態的人，等老師時＝主指導；沒建包的組整組排除）。
 *   帳號停用或去識別化的人不催。
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)

/** 一封信最多等多久（寄信服務自己的逾時是 10 秒；這裡要比它長，一封卡住也不會讓整個請求卡住）。 */
export const REMINDER_MAIL_TIMEOUT_MS = 15_000

const INTAKE = `m.status = 'published' and m.placement in ('submission', 'requirement') and m.receiver_unit <> 'none' and m.deleted_at is null`

type Queryable = Pick<PoolClient, 'query'>
type CohortRow = { id: string; code: string; name: string; status: CohortStatus }
type ItemRow = {
  id: string
  cohort_id: string
  title: string
  status: string
  placement: string
  receiver_unit: 'none' | 'individual' | 'group'
  audience_kind: string
  consent_mode: 'form' | 'upload' | null
  opens_at: Date | null
  due_at: Date | null
  deleted_at: Date | null
}

/** 一封要寄的催繳信（commit 之後才寄）。 */
type PendingMail = { readonly to: string; readonly kind: 'item' | 'grading'; readonly title: string; readonly dueAt: Date | null; readonly path: string }

/** 一份作業這次要催的人（已去重、已排除停用帳號）與每個人的信。 */
type ItemTargets = { readonly recipients: string[]; readonly mails: PendingMail[] }

type Deps = {
  audit: AuditWriter<PoolClient>
  ledger: OperationLedger<PoolClient>
  events: EventPublisher<PoolClient>
  businessClock: BusinessClockSource
  /** 沒給就只發站內通知（例如沒有寄信設定的整合測試）。 */
  mail?: { readonly mailer: Mailer; readonly siteUrl: string }
  pool?: PoolSource
  reader?: () => Queryable
  realClock?: Clock
  mailTimeoutMs?: number
}

function itemNotFound(): Err {
  return err('VALIDATION_FAILED', '找不到這份作業，請回到作業清單重新整理。', { details: { field: 'itemId' } })
}

function notIntake(): Err {
  return err('VALIDATION_FAILED', '這份不是發布中的收件作業，不能催繳。', { details: { field: 'itemId' } })
}

function archived(cohort: CohortRow): Err {
  return err('COHORT_ARCHIVED', `${cohortLabel(cohort)}已封存，不能再催繳。`)
}

function coolingDown(subject: string, last: Date, next: Date): Err {
  return err('CONFLICT', cooldownMessage(subject, last, next), {
    details: { lastRemindedAt: last.toISOString(), nextAllowedAt: next.toISOString() },
  })
}

function isIntake(item: ItemRow): boolean {
  return (
    item.status === 'published' &&
    (item.placement === 'submission' || item.placement === 'requirement') &&
    item.receiver_unit !== 'none' &&
    item.deleted_at === null
  )
}

/** 帳本存的是 JSON：回放時把時間欄位還原成 Date。 */
function withDate<R extends { nextAllowedAt: Date }>(result: Result<R>): Result<R> {
  if (!result.ok) return result
  return { ok: true, receipt: { ...result.receipt, nextAllowedAt: new Date(result.receipt.nextAllowedAt) } }
}

export class PgReminders implements ReminderCommand, ReminderQuery {
  readonly #audit: AuditWriter<PoolClient>
  readonly #ledger: OperationLedger<PoolClient>
  readonly #events: EventPublisher<PoolClient>
  readonly #businessClock: BusinessClockSource
  readonly #mail: Deps['mail']
  readonly #pool: PoolSource
  readonly #reader: () => Queryable
  readonly #realClock: Clock
  readonly #mailTimeoutMs: number

  constructor(deps: Deps) {
    this.#audit = deps.audit
    this.#ledger = deps.ledger
    this.#events = deps.events
    this.#businessClock = deps.businessClock
    this.#mail = deps.mail
    this.#pool = deps.pool ?? getPool
    this.#reader = deps.reader ?? getPool
    this.#realClock = deps.realClock ?? new RealClock()
    this.#mailTimeoutMs = deps.mailTimeoutMs ?? REMINDER_MAIL_TIMEOUT_MS
  }

  async remindItem(actor: ResolvedActor, input: { itemId: string }, requestId: string): Promise<Result<RemindItemReceipt>> {
    const blocked = authorizeAdmin(actor, '催繳')
    if (blocked) return blocked
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(input.itemId)) return itemNotFound()
    const adminId = actor.kind === 'authenticated' ? actor.userId : ''
    const businessNow = await this.#businessClock.now()

    let mails: PendingMail[] = []
    const result = await inTransaction<RemindItemReceipt>(this.#pool, 'reminders', async (tx) => {
      const head = await tx.query<{ cohort_id: string }>('select cohort_id from managed_items where id = $1', [input.itemId])
      if (!head.rows[0]) return itemNotFound()
      const cohort = await lockCohort(tx, head.rows[0].cohort_id)
      if (!cohort) return itemNotFound()
      await lockKey(tx, `reminder:item:${input.itemId}`)
      const item = await itemOf(tx, input.itemId)
      if (!item) return itemNotFound()
      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: adminId,
          operationKind: 'item.remind',
          requestId,
          fingerprint: sha256(canonicalJson({ itemId: item.id })),
          scope: 'cohort',
          cohortId: cohort.id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return withDate(replayed<RemindItemReceipt>(begun))
      if (!isIntake(item)) return notIntake()
      if (cohort.status === 'archived') return archived(cohort)

      const last = await lastRemindedAt(tx, 'item', item.id)
      const next = nextAllowedAt(last, realAt)
      if (last && next) return coolingDown(`「${item.title}」`, last, next)

      const targets = await this.#itemTargets(tx, item, businessNow, 'all')
      if (targets.recipients.length === 0) return err('CONFLICT', `「${item.title}」名單上的人都已完成，不需要催繳。`)
      await this.#publishItem(tx, { item, cohort, adminId, realAt, businessNow, recipients: targets.recipients, scope: 'item' })
      mails = targets.mails
      const receipt: RemindItemReceipt = {
        itemId: item.id,
        title: item.title,
        notified: targets.recipients.length,
        mailed: mails.length,
        remindedAt: realAt.toISOString(),
        nextAllowedAt: cooldownEndsAt(realAt),
      }
      const meta = { requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt: { ...receipt, ...meta }, resultRef: { itemId: item.id } })
      return ok(receipt, meta)
    })
    if (!result.ok || mails.length === 0) return result
    const mailed = await this.#send(mails)
    return { ok: true, receipt: { ...result.receipt, mailed } }
  }

  async remindOverdue(actor: ResolvedActor, input: { cohortId: string }, requestId: string): Promise<Result<RemindOverdueReceipt>> {
    const blocked = authorizeAdmin(actor, '催繳')
    if (blocked) return blocked
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(input.cohortId)) return cohortNotFound()
    const adminId = actor.kind === 'authenticated' ? actor.userId : ''
    const businessNow = await this.#businessClock.now()

    let mails: PendingMail[] = []
    const result = await inTransaction<RemindOverdueReceipt>(this.#pool, 'reminders', async (tx) => {
      const cohort = await lockCohort(tx, input.cohortId)
      if (!cohort) return cohortNotFound()
      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: adminId,
          operationKind: 'item.remind',
          requestId,
          fingerprint: sha256(canonicalJson({ cohortId: cohort.id, scope: 'overdue' })),
          scope: 'cohort',
          cohortId: cohort.id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<RemindOverdueReceipt>(begun)
      if (cohort.status === 'archived') return archived(cohort)

      // 已截止的發布中作業；順序同作業清單（最近更新的在前）。鎖照 id 排序拿，跟單份催繳不會互鎖。
      const due = await tx.query<ItemRow & { updated_at: Date }>(
        `select ${ITEM_COLUMNS}, m.updated_at from managed_items m
          where m.cohort_id = $1 and ${INTAKE} and m.due_at is not null and m.due_at <= $2
          order by m.updated_at desc, m.id`,
        [cohort.id, businessNow],
      )
      for (const id of due.rows.map((r) => r.id).sort()) await lockKey(tx, `reminder:item:${id}`)

      const items: RemindOverdueItem[] = []
      for (const item of due.rows) {
        const targets = await this.#itemTargets(tx, item, businessNow, 'overdue')
        if (targets.recipients.length === 0) continue
        const last = await lastRemindedAt(tx, 'item', item.id)
        if (last && nextAllowedAt(last, realAt)) {
          items.push({ itemId: item.id, title: item.title, notified: 0, skippedCooldown: true })
          continue
        }
        await this.#publishItem(tx, { item, cohort, adminId, realAt, businessNow, recipients: targets.recipients, scope: 'overdue' })
        mails = [...mails, ...targets.mails]
        items.push({ itemId: item.id, title: item.title, notified: targets.recipients.length, skippedCooldown: false })
      }
      if (items.length === 0) return err('CONFLICT', '目前沒有逾期未繳的作業，不需要催繳。')
      const receipt: RemindOverdueReceipt = {
        items,
        notified: items.reduce((n, i) => n + i.notified, 0),
        mailed: mails.length,
        remindedAt: realAt.toISOString(),
      }
      const meta = { requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt: { ...receipt, ...meta }, resultRef: { cohortId: cohort.id } })
      return ok(receipt, meta)
    })
    if (!result.ok || mails.length === 0) return result
    const mailed = await this.#send(mails)
    return { ok: true, receipt: { ...result.receipt, mailed } }
  }

  async remindGrading(actor: ResolvedActor, input: { cohortId: string }, requestId: string): Promise<Result<RemindGradingReceipt>> {
    const blocked = authorizeAdmin(actor, '催繳')
    if (blocked) return blocked
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(input.cohortId)) return cohortNotFound()
    const adminId = actor.kind === 'authenticated' ? actor.userId : ''
    const businessNow = await this.#businessClock.now()

    const mails: PendingMail[] = []
    const result = await inTransaction<RemindGradingReceipt>(this.#pool, 'reminders', async (tx) => {
      const cohort = await lockCohort(tx, input.cohortId)
      if (!cohort) return cohortNotFound()
      await lockKey(tx, `reminder:grading:${cohort.id}`)
      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: adminId,
          operationKind: 'grading.remind',
          requestId,
          fingerprint: sha256(canonicalJson({ cohortId: cohort.id })),
          scope: 'cohort',
          cohortId: cohort.id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return withDate(replayed<RemindGradingReceipt>(begun))
      if (cohort.status === 'archived') return archived(cohort)

      const last = await lastRemindedAt(tx, 'grading', cohort.id)
      const next = nextAllowedAt(last, realAt)
      if (last && next) return coolingDown(`${cohortLabel(cohort)}的評分`, last, next)

      const behind = teachersBehind(await gradingCounts(tx, cohort.id))
      const contacts = await activeContacts(tx, behind.map((b) => b.teacherUserId))
      const targets = behind.filter((b) => contacts.has(b.teacherUserId))
      if (targets.length === 0) return err('CONFLICT', '本屆的評分都已送齊，不需要催繳。')

      const eventIds: string[] = []
      for (const t of targets) {
        const title = gradingReminderTitle(t.pending)
        const { eventId } = await this.#events.publish(tx, {
          type: 'grading.reminded',
          scope: 'cohort',
          cohortId: cohort.id,
          source: { type: 'grading_cohort', id: cohort.id, version: null },
          actor: { kind: 'user', userId: adminId },
          recipients: [t.teacherUserId],
          recipientBasis: { basis: 'evaluator_assignments_not_counted', cohortId: cohort.id, pending: t.pending },
          payload: { title, cohortId: cohort.id, pending: t.pending },
          occurredRealAt: realAt,
          occurredBusinessAt: businessNow,
        })
        eventIds.push(eventId)
        const email = contacts.get(t.teacherUserId)
        if (email) mails.push({ to: email, kind: 'grading', title, dueAt: null, path: '/dashboard/teacher/grading' })
      }
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: adminId,
        role: 'admin',
        action: 'grading.remind',
        targetType: 'cohort',
        targetId: cohort.id,
        scope: 'cohort',
        cohortId: cohort.id,
        realAt,
        businessAt: businessNow,
        payload: { eventIds, teachers: targets.map((t) => ({ userId: t.teacherUserId, pending: t.pending })) },
      })
      const receipt: RemindGradingReceipt = {
        cohortId: cohort.id,
        notified: targets.length,
        mailed: mails.length,
        remindedAt: realAt.toISOString(),
        nextAllowedAt: cooldownEndsAt(realAt),
      }
      const meta = { requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt: { ...receipt, ...meta }, resultRef: { cohortId: cohort.id } })
      return ok(receipt, meta)
    })
    if (!result.ok || mails.length === 0) return result
    const mailed = await this.#send(mails)
    return { ok: true, receipt: { ...result.receipt, mailed } }
  }

  async lastReminded(actor: ResolvedActor, kind: 'item' | 'grading', sourceId: string): Promise<Result<LastReminded>> {
    const blocked = authorizeAdmin(actor, '查看催繳紀錄')
    if (blocked) return blocked
    if (kind !== 'item' && kind !== 'grading') return err('VALIDATION_FAILED', '催繳種類不對，請重新整理頁面。')
    if (!isUuid(sourceId)) return kind === 'item' ? itemNotFound() : cohortNotFound()
    const now = this.#realClock.now()
    const at = await lastRemindedAt(this.#reader(), kind, sourceId)
    return ok({ at, nextAllowedAt: nextAllowedAt(at, now) }, { requestId: uuidv7(), serverTime: now.toISOString() })
  }

  // ── 內部 ──────────────────────────────────────────────────────────────────

  /** 一份作業這次要催的人：先挑名單上還沒完成的收件者，再展開成人（整組→組員、同意書→還沒表態的人）。 */
  async #itemTargets(tx: PoolClient, item: ItemRow, businessNow: Date, scope: 'all' | 'overdue'): Promise<ItemTargets> {
    const consent = item.consent_mode === 'form'
    const receivers = await receiversOf(tx, item, businessNow)
    const pending = pendingReceiverIds(receivers, { scope, consent })
    if (pending.length === 0) return { recipients: [], mails: [] }

    // 每個人點進哪一頁：同意書學生進簽核頁、主指導進老師的簽核頁；給老師的作業進老師作業區；其餘進學生作業區。
    const paths = new Map<string, string>()
    if (consent) {
      for (const p of await consentPending(tx, item.id, pending)) {
        paths.set(p.userId, p.advisor ? '/dashboard/teacher/signoff' : '/dashboard/student/signoff')
      }
    } else {
      const path = item.audience_kind === 'teachers' ? `/dashboard/teacher/affairs/${item.id}` : `/dashboard/student/affairs/${item.id}`
      const people = item.receiver_unit === 'group' ? await activeMembersOf(tx, pending) : pending
      for (const userId of people) paths.set(userId, path)
    }
    const contacts = await activeContacts(tx, [...paths.keys()])
    const recipients = [...paths.keys()].filter((id) => contacts.has(id)).sort()
    const mails = recipients.flatMap((id): PendingMail[] => {
      const to = contacts.get(id)
      return to ? [{ to, kind: 'item', title: item.title, dueAt: item.due_at, path: paths.get(id)! }] : []
    })
    return { recipients, mails }
  }

  async #publishItem(
    tx: PoolClient,
    input: {
      item: ItemRow
      cohort: CohortRow
      adminId: string
      realAt: Date
      businessNow: Date
      recipients: string[]
      scope: 'item' | 'overdue'
    },
  ): Promise<void> {
    const { item, cohort } = input
    const { eventId } = await this.#events.publish(tx, {
      type: 'item.reminded',
      scope: 'cohort',
      cohortId: cohort.id,
      source: { type: 'item', id: item.id, version: null },
      actor: { kind: 'user', userId: input.adminId },
      recipients: input.recipients,
      recipientBasis: { basis: item.consent_mode === 'form' ? 'signoff_not_voted' : 'response_rosters_pending', itemId: item.id, scope: input.scope },
      payload: { title: itemReminderTitle(item.title, item.due_at), itemId: item.id, dueAt: item.due_at?.toISOString() ?? null },
      occurredRealAt: input.realAt,
      occurredBusinessAt: input.businessNow,
    })
    await this.#audit.append(tx, {
      actorKind: 'user',
      actorUserId: input.adminId,
      role: 'admin',
      action: 'item.remind',
      targetType: 'item',
      targetId: item.id,
      scope: 'cohort',
      cohortId: cohort.id,
      realAt: input.realAt,
      businessAt: input.businessNow,
      payload: { eventId, recipientUserIds: input.recipients, from: input.scope },
    })
  }

  /**
   * commit 之後寄信：同時寄、全部結束才回；回寄出（`sent`／`captured`）的封數。
   * 每封有逾時（比寄信服務自己的逾時長）；失敗、逾時、連 outbox 都寫不進去都只記 log，不影響已完成的催繳。
   */
  async #send(mails: readonly PendingMail[]): Promise<number> {
    const mail = this.#mail
    if (!mail) return 0
    const origin = mail.siteUrl.replace(/\/+$/, '')
    const results = await Promise.allSettled(
      mails.map((m) =>
        withTimeout(
          mail.mailer.send({ to: m.to, ...reminderMail(m.kind, { title: m.title, dueAt: m.dueAt, url: `${origin}${m.path}` }) }),
          this.#mailTimeoutMs,
        ),
      ),
    )
    let sent = 0
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.ok) sent += 1
      else if (r.status === 'rejected') console.error('[reminders] 催繳信寄送失敗（催繳已完成）', r.reason instanceof Error ? r.reason.name : 'unknown error')
    }
    return sent
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('催繳信逾時'), { name: 'TimeoutError' })), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

const ITEM_COLUMNS = `m.id, m.cohort_id, m.title, m.status, m.placement, m.receiver_unit, m.audience_kind, m.consent_mode,
  m.opens_at, m.due_at, m.deleted_at`

async function itemOf(db: Queryable, itemId: string): Promise<ItemRow | null> {
  const row = await db.query<ItemRow>(`select ${ITEM_COLUMNS} from managed_items m where m.id = $1`, [itemId])
  return row.rows[0] ?? null
}

async function lockCohort(tx: PoolClient, cohortId: string): Promise<CohortRow | null> {
  const row = await tx.query<CohortRow>('select id, code, name, status from cohorts where id = $1 for share', [cohortId])
  return row.rows[0] ?? null
}

/** 交易級 advisory lock：同一份作業（同一屆的評分）的催繳排隊，交易結束自動放。 */
async function lockKey(tx: PoolClient, key: string): Promise<void> {
  await tx.query('select pg_advisory_xact_lock(hashtext($1))', [key])
}

const SOURCE_OF = { item: 'item', grading: 'grading_cohort' } as const
const TYPE_OF = { item: 'item.reminded', grading: 'grading.reminded' } as const

/** 這份作業（這一屆評分）最近一次催繳的真實時間。 */
async function lastRemindedAt(db: Queryable, kind: 'item' | 'grading', sourceId: string): Promise<Date | null> {
  const row = await db.query<{ at: Date | null }>(
    `select max(occurred_real_at) as at from domain_events where type = $1 and source_type = $2 and source_id = $3`,
    [TYPE_OF[kind], SOURCE_OF[kind], sourceId],
  )
  return row.rows[0]?.at ?? null
}

/** 名單上每位收件者取一列（目前那一列優先），帶分類、有沒有正式版本與逾期（同名單頁的挑法與 `receiverStatus`）。 */
async function receiversOf(db: Queryable, item: ItemRow, businessNow: Date): Promise<ReminderReceiver[]> {
  const rows = await db.query<{
    receiver_id: string
    eligible_to_business_at: Date | null
    exempt: boolean
    has_draft: boolean
    latest_version_no: number | null
    reopen_until: Date | null
  }>(
    `with picked as (
       select distinct on (r.receiver_kind, r.receiver_id) r.*
         from response_rosters r
        where r.item_id = $1
        order by r.receiver_kind, r.receiver_id, (r.eligible_to_business_at is null) desc,
                 r.eligible_to_business_at desc nulls first, r.eligible_from_business_at desc, r.id desc
     )
     select r.receiver_id, r.eligible_to_business_at, r.exempt, facts.has_draft, latest.version_no as latest_version_no,
            ${REOPEN_UNTIL}
       from picked r
       ${receiverFactsJoin('r.item_id', 'r.receiver_kind', 'r.receiver_id')}
      order by r.receiver_id`,
    [item.id],
  )
  const window = { opensAt: item.opens_at, dueAt: item.due_at }
  return rows.rows.map((r) => {
    const facts = { eligibleTo: r.eligible_to_business_at, exempt: r.exempt, hasDraft: r.has_draft, latestVersionNo: r.latest_version_no, reopenUntil: r.reopen_until }
    return {
      receiverId: r.receiver_id,
      current: categoryOf(facts) === 'current',
      submitted: r.latest_version_no !== null,
      // 「逾期」只看時間窗：同意書不看繳交版本，所以用「還沒送出」的事實去算。
      overdue: receiverStatus(window, { ...facts, latestVersionNo: null }, businessNow).overdue,
    }
  })
}

/** 整組收件的組 → 該組此刻的有效組員（組別未解散）。 */
async function activeMembersOf(db: Queryable, groupIds: readonly string[]): Promise<string[]> {
  const rows = await db.query<{ user_id: string }>(
    `select distinct gm.user_id from group_memberships gm join groups g on g.id = gm.group_id and g.status = 'active'
      where gm.group_id = any($1::uuid[]) and gm.valid_to is null`,
    [groupIds],
  )
  return rows.rows.map((r) => r.user_id)
}

/** 站內同意書：這些組的包（`item_id`＝這份作業）目前版本還沒表態的人。沒建包的組不在結果裡。 */
async function consentPending(db: Queryable, itemId: string, groupIds: readonly string[]): Promise<{ userId: string; advisor: boolean }[]> {
  const versions = await db.query<{ version_id: string; participants: unknown; state: SignoffState }>(
    `select v.id as version_id, v.participants, s.state
       from signoff_packages p
       join signoff_package_versions v on v.id = p.current_version_id
       join signoff_version_status s on s.version_id = v.id
      where p.item_id = $1 and p.group_id = any($2::uuid[])`,
    [itemId, groupIds],
  )
  if (versions.rows.length === 0) return []
  const votes = await db.query<{ version_id: string; user_id: string; role: VoteRecord['role']; result: VoteRecord['result']; reason: string | null; real_at: Date }>(
    `select version_id, user_id, role, result, reason, real_at from approvals where version_id = any($1::uuid[]) order by real_at`,
    [versions.rows.map((v) => v.version_id)],
  )
  const out: { userId: string; advisor: boolean }[] = []
  for (const v of versions.rows) {
    const participants = readParticipants(v.participants)
    if (!participants) continue
    const mine = votes.rows
      .filter((x) => x.version_id === v.version_id)
      .map((x): VoteRecord => ({ userId: x.user_id, role: x.role, result: x.result, reason: x.reason, realAt: x.real_at }))
    for (const userId of remindRecipients(buildProgress(participants, mine, v.state), v.state)) {
      out.push({ userId, advisor: userId === participants.advisor.userId })
    }
  }
  return out
}

/** 帳號正常（啟用、未去識別）的人與登入 Email；停用的人不催、不寄。 */
async function activeContacts(db: Queryable, userIds: readonly string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map()
  const rows = await db.query<{ id: string; email: string }>(
    `select id, email from users where id = any($1::uuid[]) and status = 'active' and deidentified_at is null`,
    [[...new Set(userIds)]],
  )
  return new Map(rows.rows.map((r) => [r.id, r.email]))
}

/**
 * 本屆每位老師的評分份數，口徑同系辦成績頁的 `teacherProgress`：目前方案版本的階段、未解散的組、有效指派；
 * 已送出＝那份指派有一筆 `counted` 的評分。
 */
async function gradingCounts(db: Queryable, cohortId: string): Promise<{ teacherUserId: string; assigned: number; counted: number }[]> {
  const rows = await db.query<{ teacher_user_id: string; assigned: number; counted: number }>(
    `select a.teacher_user_id, count(*)::int as assigned,
            count(*) filter (where exists (
              select 1 from evaluations e join evaluation_status s on s.evaluation_id = e.id
               where e.assignment_id = a.id and s.state = 'counted'))::int as counted
       from evaluator_assignments a
       join groups g on g.id = a.group_id and g.status = 'active' and g.cohort_id = $1
       join grading_schemes sc on sc.cohort_id = $1
       join grading_scheme_versions v on v.id = sc.current_version_id
      where a.valid_to is null
        and a.stage_key in (select x->>'key' from jsonb_array_elements(v.stages) x)
      group by a.teacher_user_id`,
    [cohortId],
  )
  return rows.rows.map((r) => ({ teacherUserId: r.teacher_user_id, assigned: r.assigned, counted: r.counted }))
}
