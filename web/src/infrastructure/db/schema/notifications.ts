import 'server-only'
import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { users } from '@/infrastructure/db/schema/auth'
import { cohorts, domainEvents } from '@/infrastructure/db/schema/base'

/**
 * 模組 08 站內通知與日曆的三張擁有表（模組 08 附錄 A；第三支 migration，票 11）。
 *
 * 票 11 只建表；寫入者是票 12 的背景工作（投影事件成通知、心跳）與通知匣（已讀）。
 * 事件、投影、到期工作三張共用表在 S00 就建好了（契約 01 §4.5–4.7），這裡不重建。
 */

const tz = { withTimezone: true } as const

/**
 * 通知（附錄 A `notifications`）。以「事件＋收件人」去重：同一人兼具多個收件身分也只一則。
 * 列上只存 ID 與標題，渲染時再回來源重驗權限（模組 08 §4「舊通知與失權」）。
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => domainEvents.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    recipientUserId: uuid('recipient_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    scope: text('scope').notNull(),
    cohortId: uuid('cohort_id').references(() => cohorts.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    sourceRef: jsonb('source_ref').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    readAt: timestamp('read_at', tz),
  },
  (t) => [
    unique('notifications_event_recipient_unique').on(t.eventId, t.recipientUserId),
    check('notifications_scope_check', sql`${t.scope} in ('cohort','global')`),
    check('notifications_scope_cohort_check', sql`(${t.scope} = 'cohort') = (${t.cohortId} is not null)`),
    index('notifications_recipient_created_idx').on(t.recipientUserId, t.createdAt.desc()),
    index('notifications_recipient_read_idx').on(t.recipientUserId, t.readAt),
  ],
)

/**
 * 彙整事件（附錄 A `digest_events`；不可變）：逾期、未指派、投影失敗、備份失敗。
 * 去重鍵與到期工作同一個 identity（契約 01 §4.7）。
 */
export const digestEvents = pgTable(
  'digest_events',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind').notNull(),
    cohortId: uuid('cohort_id').references(() => cohorts.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    subjectId: uuid('subject_id'),
    deadlineVersion: integer('deadline_version').notNull(),
    count: integer('count').notNull(),
    payload: jsonb('payload').notNull(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => domainEvents.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    generatedBusinessAt: timestamp('generated_business_at', tz).notNull(),
  },
  (t) => [
    unique('digest_events_identity').on(t.kind, t.subjectId, t.deadlineVersion),
    check(
      'digest_events_kind_check',
      sql`${t.kind} in ('overdue','unassigned_groups','projection_failed','backup_failed')`,
    ),
  ],
)

/** 背景工作的心跳（附錄 A `worker_heartbeat`；固定一列，`/api/health` 讀）。 */
export const workerHeartbeat = pgTable(
  'worker_heartbeat',
  {
    id: smallint('id').primaryKey(),
    version: text('version').notNull(),
    lastTickRealAt: timestamp('last_tick_real_at', tz).notNull(),
    lastProjectionAt: timestamp('last_projection_at', tz),
    lastDueWorkAt: timestamp('last_due_work_at', tz),
    updatedAt: timestamp('updated_at', tz).notNull(),
  },
  (t) => [check('worker_heartbeat_single_row_check', sql`${t.id} = 1`)],
)
