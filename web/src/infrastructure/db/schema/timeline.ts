import 'server-only'
import { sql } from 'drizzle-orm'
import { boolean, check, date, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { users } from '@/infrastructure/db/schema/auth'
import { cohorts } from '@/infrastructure/db/schema/base'

/**
 * 模組 02 屆別與年度流程的四張擁有表（模組 02 附錄 A；第三支 migration，票 11）。
 *
 * 通用規則同契約 01 §1：uuid 主鍵、列舉用 CHECK、timestamptz、FK RESTRICT、可變頭列帶 revision。
 * 純日期（階段開始日、年度結束日）用 `date`，都是臺灣日曆日；換成瞬間一律經 `@/shared/time`。
 */

const tz = { withTimezone: true } as const

/**
 * 屆別的階段（附錄 A `cohort_stages`）。
 *
 * 只存開始日：下一階段的開始日 00:00 起就不再屬於上一階段，最後一段到年度結束日（含當天）。
 * `deadline_version` 在這一段的日期範圍改變時 +1（開始日變、或下一段開始日／年度結束日變），
 * 給之後依階段排的到期工作換版用（契約 01 §4.7）。
 */
export const cohortStages = pgTable(
  'cohort_stages',
  {
    id: uuid('id').primaryKey(),
    cohortId: uuid('cohort_id')
      .notNull()
      .references(() => cohorts.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    seq: integer('seq').notNull(),
    name: text('name').notNull(),
    /** 一句話說這階段要做什麼（原型 `Stage.summary`；學生時間軸顯示）。0011 補，舊列是空字串。 */
    description: text('description').notNull().default(''),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    deadlineVersion: integer('deadline_version').notNull().default(1),
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
    unique('cohort_stages_seq_unique').on(t.cohortId, t.seq),
    // 開始日嚴格遞增的 DB 後盾：同一屆不會有兩段同一天開始。遞增本身由用例驗。
    unique('cohort_stages_start_date_unique').on(t.cohortId, t.startDate),
    check('cohort_stages_seq_check', sql`${t.seq} >= 1`),
    check('cohort_stages_description_check', sql`length(${t.description}) <= 200`),
    check('cohort_stages_created_by_kind_check', sql`${t.createdByKind} in ('user','system','worker')`),
    check(
      'cohort_stages_created_by_actor_check',
      sql`(${t.createdByKind} = 'user') = (${t.createdByUserId} is not null)`,
    ),
  ],
)

/**
 * 獨立活動：說明會、成果發表這類（附錄 A `project_events`）。
 *
 * 作業截止不在這裡——那是收件項目衍生到日曆的（模組 08 §4「站內日曆」）。
 * 取消不刪列，只把 `status` 改成 cancelled，列表與日曆照實顯示「已取消」。
 */
export const projectEvents = pgTable(
  'project_events',
  {
    id: uuid('id').primaryKey(),
    cohortId: uuid('cohort_id')
      .notNull()
      .references(() => cohorts.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    title: text('title').notNull(),
    description: text('description'),
    startsAt: timestamp('starts_at', tz).notNull(),
    endsAt: timestamp('ends_at', tz),
    allDay: boolean('all_day').notNull().default(false),
    audienceKind: text('audience_kind').notNull(),
    status: text('status').notNull().default('scheduled'),
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
    check('project_events_ends_after_starts_check', sql`${t.endsAt} is null or ${t.endsAt} >= ${t.startsAt}`),
    check(
      'project_events_audience_kind_check',
      sql`${t.audienceKind} in ('public','signed_in','cohort_students','teachers')`,
    ),
    check('project_events_status_check', sql`${t.status} in ('scheduled','cancelled')`),
    check('project_events_created_by_kind_check', sql`${t.createdByKind} in ('user','system','worker')`),
    check(
      'project_events_created_by_actor_check',
      sql`(${t.createdByKind} = 'user') = (${t.createdByUserId} is not null)`,
    ),
    index('project_events_cohort_starts_idx').on(t.cohortId, t.startsAt),
  ],
)

/**
 * 模擬業務鐘的每一次設定（附錄 A `business_clock_overrides`；不可變）。
 *
 * 只寫不改，永遠取最新一筆（`real_at desc, id desc`）。業務時間＝最新一筆的 `business_at`
 * 加上「從那次設定到現在的真實經過時間」。正式站（`BUSINESS_CLOCK_OVERRIDE_ENABLED=false`）
 * 不讀也不寫這張表；`environment` 只收 local／staging，正式站本來就不該有列。
 */
export const businessClockOverrides = pgTable(
  'business_clock_overrides',
  {
    id: uuid('id').primaryKey(),
    environment: text('environment').notNull(),
    businessAt: timestamp('business_at', tz).notNull(),
    realAt: timestamp('real_at', tz).notNull(),
    previousBusinessAt: timestamp('previous_business_at', tz),
    setByUserId: uuid('set_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    reason: text('reason').notNull(),
  },
  (t) => [
    check('business_clock_overrides_environment_check', sql`${t.environment} in ('local','staging')`),
    check('business_clock_overrides_reason_check', sql`length(btrim(${t.reason})) > 0`),
    index('business_clock_overrides_real_at_idx').on(t.realAt),
  ],
)

/**
 * 屆別狀態的每一次變化（附錄 A `cohort_status_events`；不可變）。
 *
 * `from_status` 為 NULL 代表「建立」。附錄 A 寫 `reason NOT NULL`（封存與解封必填），
 * 但轉進行中沒有理由可填，所以這裡改成：只有進出「已封存」時理由必填（CHECK 把關）。
 */
export const cohortStatusEvents = pgTable(
  'cohort_status_events',
  {
    id: uuid('id').primaryKey(),
    cohortId: uuid('cohort_id')
      .notNull()
      .references(() => cohorts.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    reason: text('reason'),
    unfinishedSummary: jsonb('unfinished_summary'),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    realAt: timestamp('real_at', tz).notNull(),
    businessAt: timestamp('business_at', tz).notNull(),
  },
  (t) => [
    check(
      'cohort_status_events_from_status_check',
      sql`${t.fromStatus} is null or ${t.fromStatus} in ('preparing','active','archived')`,
    ),
    check('cohort_status_events_to_status_check', sql`${t.toStatus} in ('preparing','active','archived')`),
    check(
      'cohort_status_events_archive_reason_check',
      sql`(${t.toStatus} <> 'archived' and ${t.fromStatus} is distinct from 'archived') or ${t.reason} is not null`,
    ),
    index('cohort_status_events_cohort_real_at_idx').on(t.cohortId, t.realAt),
  ],
)
