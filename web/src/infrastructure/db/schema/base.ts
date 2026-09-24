import 'server-only'
import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { users } from '@/infrastructure/db/schema/auth'

/**
 * 共用基礎表（契約 01 §4.2–§4.8）。第一支 migration 建這些（S00-04）。
 *
 * 通用規則（契約 01 §1）：
 * - 主鍵一律 uuid（應用產生 uuidv7）。
 * - 列舉用 `text NOT NULL CHECK (col IN (...))`，不用 pgEnum，方便 expand／contract。
 * - 時間欄一律 timestamptz（UTC）；業務事件同時存 `*_real_at` 與 `*_business_at`。
 * - actor：`actor_kind` ∈ user/system/worker，`(actor_kind='user') = (actor_user_id IS NOT NULL)`。
 * - scope：`scope` ∈ cohort/global，`(scope='cohort') = (cohort_id IS NOT NULL)`。
 * - FK 預設 RESTRICT；使用者列永不硬刪，所以沒有 CASCADE。
 */

const tz = { withTimezone: true } as const

export const cohorts = pgTable(
  'cohorts',
  {
    id: uuid('id').primaryKey(),
    code: text('code').notNull().unique(),
    name: text('name').notNull(),
    status: text('status').notNull().default('preparing'),
    isDefaultWorking: boolean('is_default_working').notNull().default(false),
    isRegistrationOpen: boolean('is_registration_open').notNull().default(false),
    /**
     * 年度結束日（臺灣日期，含當天；模組 02 附錄 A，票 11）。籌備中可以還沒設；
     * 「轉進行中必須有」由 activate 用例把關——舊屆別升版後是 NULL，不在 DB 加 CHECK。
     */
    yearEndDate: date('year_end_date', { mode: 'string' }),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    createdByKind: text('created_by_kind').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
  },
  (t) => [
    check('cohorts_status_check', sql`${t.status} in ('preparing','active','archived')`),
    check('cohorts_created_by_kind_check', sql`${t.createdByKind} in ('user','system','worker')`),
    check(
      'cohorts_created_by_actor_check',
      sql`(${t.createdByKind} = 'user') = (${t.createdByUserId} is not null)`,
    ),
    // 只能有一個預設工作屆別、一個開放註冊屆別。
    uniqueIndex('cohorts_one_default_working').on(t.isDefaultWorking).where(sql`${t.isDefaultWorking}`),
    uniqueIndex('cohorts_one_registration_open')
      .on(t.isRegistrationOpen)
      .where(sql`${t.isRegistrationOpen}`),
  ],
)

export const schemaMeta = pgTable('schema_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
})

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey(),
    actorKind: text('actor_kind').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    role: text('role'),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id'),
    scope: text('scope').notNull(),
    cohortId: uuid('cohort_id').references(() => cohorts.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    reason: text('reason'),
    verificationMethod: text('verification_method'),
    realAt: timestamp('real_at', tz).notNull(),
    businessAt: timestamp('business_at', tz).notNull(),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    check('audit_events_actor_kind_check', sql`${t.actorKind} in ('user','system','worker')`),
    check('audit_events_actor_check', sql`(${t.actorKind} = 'user') = (${t.actorUserId} is not null)`),
    check('audit_events_role_check', sql`${t.role} is null or ${t.role} in ('student','teacher','admin')`),
    check('audit_events_scope_check', sql`${t.scope} in ('cohort','global')`),
    check('audit_events_scope_cohort_check', sql`(${t.scope} = 'cohort') = (${t.cohortId} is not null)`),
    check(
      'audit_events_verification_method_check',
      sql`${t.verificationMethod} is null or ${t.verificationMethod} in ('id_document','school_channel','other')`,
    ),
    index('audit_events_target_idx').on(t.targetType, t.targetId),
    index('audit_events_cohort_real_at_idx').on(t.cohortId, t.realAt),
    index('audit_events_actor_real_at_idx').on(t.actorUserId, t.realAt),
  ],
)

export const operationRecords = pgTable(
  'operation_records',
  {
    id: uuid('id').primaryKey(),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    operationKind: text('operation_kind').notNull(),
    requestId: uuid('request_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    state: text('state').notNull(),
    resultRef: jsonb('result_ref').notNull().default(sql`'{}'::jsonb`),
    receipt: jsonb('receipt'),
    scope: text('scope').notNull(),
    cohortId: uuid('cohort_id').references(() => cohorts.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    committedRealAt: timestamp('committed_real_at', tz).notNull(),
    receiptExpiresAt: timestamp('receipt_expires_at', tz).notNull(),
  },
  (t) => [
    // 去重鍵：同一個人、同一種操作、同一個 requestId 只會有一筆。
    unique('operation_records_dedupe_key').on(t.actorUserId, t.operationKind, t.requestId),
    check('operation_records_state_check', sql`${t.state} in ('committed','failed')`),
    check('operation_records_scope_check', sql`${t.scope} in ('cohort','global')`),
    check('operation_records_scope_cohort_check', sql`(${t.scope} = 'cohort') = (${t.cohortId} is not null)`),
  ],
)

export const domainEvents = pgTable(
  'domain_events',
  {
    id: uuid('id').primaryKey(),
    type: text('type').notNull(),
    scope: text('scope').notNull(),
    cohortId: uuid('cohort_id').references(() => cohorts.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    sourceType: text('source_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    sourceVersion: integer('source_version'),
    actorKind: text('actor_kind').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    occurredRealAt: timestamp('occurred_real_at', tz).notNull(),
    occurredBusinessAt: timestamp('occurred_business_at', tz).notNull(),
    recipients: uuid('recipients').array().notNull().default(sql`'{}'::uuid[]`),
    recipientBasis: jsonb('recipient_basis').notNull().default(sql`'{}'::jsonb`),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    check('domain_events_scope_check', sql`${t.scope} in ('cohort','global')`),
    check('domain_events_scope_cohort_check', sql`(${t.scope} = 'cohort') = (${t.cohortId} is not null)`),
    check('domain_events_actor_kind_check', sql`${t.actorKind} in ('user','system','worker')`),
    check('domain_events_actor_check', sql`(${t.actorKind} = 'user') = (${t.actorUserId} is not null)`),
    index('domain_events_occurred_real_at_idx').on(t.occurredRealAt),
    index('domain_events_source_idx').on(t.sourceType, t.sourceId),
  ],
)

export const eventProjections = pgTable(
  'event_projections',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => domainEvents.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    consumer: text('consumer').notNull(),
    state: text('state').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    claimedAt: timestamp('claimed_at', tz),
    doneAt: timestamp('done_at', tz),
    lastError: text('last_error'),
  },
  (t) => [
    primaryKey({ name: 'event_projections_pkey', columns: [t.eventId, t.consumer] }),
    check('event_projections_consumer_check', sql`${t.consumer} in ('notifications','digest','showcase')`),
    check('event_projections_state_check', sql`${t.state} in ('pending','done','failed')`),
    index('event_projections_state_event_idx').on(t.state, t.eventId),
  ],
)

export const dueWork = pgTable(
  'due_work',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    deadlineVersion: integer('deadline_version').notNull().default(1),
    dueBusinessAt: timestamp('due_business_at', tz).notNull(),
    state: text('state').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', tz),
    doneAt: timestamp('done_at', tz),
    resultRef: jsonb('result_ref'),
    lastError: text('last_error'),
  },
  (t) => [
    unique('due_work_identity').on(t.kind, t.subjectType, t.subjectId, t.deadlineVersion),
    check(
      'due_work_kind_check',
      sql`${t.kind} in ('proposal_expiry','deadline_snapshot','snapshot_reconcile','overdue_digest','stage_end_unassigned','file_gc','receipt_purge','test_noop')`,
    ),
    check('due_work_state_check', sql`${t.state} in ('pending','done','cancelled','failed')`),
    index('due_work_state_due_idx').on(t.state, t.dueBusinessAt),
    index('due_work_state_next_attempt_idx').on(t.state, t.nextAttemptAt),
  ],
)
