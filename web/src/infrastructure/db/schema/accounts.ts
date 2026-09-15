import 'server-only'
import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
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
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import { users } from '@/infrastructure/db/schema/auth'
import { cohorts } from '@/infrastructure/db/schema/base'
import { storedFiles } from '@/infrastructure/db/schema/files'

/**
 * 模組 01 帳號與權限的九張擁有表（模組 01 v2.4 附錄 A）。第二支 migration 建這些（S01-01）。
 *
 * S00 的表一張都不動；這裡只新增。通用規則同契約 01 §1
 * （uuid 主鍵、列舉用 CHECK、timestamptz、FK RESTRICT、可變頭列帶 revision）。
 *
 * 系級（`department_class`，2026-09-15 Roy 定案）：是「資管二甲／資管二乙」這類完整文字，
 * 跟專題屆別（`cohort_id`）是兩回事，不能互相推導。舊資料缺值一律保留 NULL，不從屆別猜填，
 * 所以三張表的這一欄都是 nullable：名單列（來源）、註冊申請（申請人填的）、
 * 個人資料（核准後的學生資料）。申請的修改歷史存在 `application_revisions.snapshot` 裡。
 */

const tz = { withTimezone: true } as const

/** 一人一份的個人資料（附錄 A `user_profiles`）。 */
export const userProfiles = pgTable(
  'user_profiles',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    displayName: text('display_name').notNull(),
    nameNormalized: text('name_normalized').notNull(),
    /** 老師為 NULL；文字保留前導零。 */
    studentNo: text('student_no'),
    /** 系級完整文字（資管二甲／資管二乙）；與 `cohort_id` 分開，缺值留白。 */
    departmentClass: text('department_class'),
    cohortId: uuid('cohort_id').references(() => cohorts.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    phone: text('phone'),
    contactEmail: text('contact_email').notNull(),
    /** 只是列表顯示用；判定一律看 `sessions.login_method`（模組 01 §2）。 */
    loginMethodLast: text('login_method_last'),
    profileCompletedAt: timestamp('profile_completed_at', tz),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
  },
  (t) => [
    check(
      'user_profiles_login_method_last_check',
      sql`${t.loginMethodLast} is null or ${t.loginMethodLast} in ('google','password')`,
    ),
    index('user_profiles_cohort_idx').on(t.cohortId),
    index('user_profiles_student_no_idx').on(t.studentNo),
  ],
)

/**
 * 有效學號的占用表（附錄 A `student_identities`）。
 *
 * 契約 01 §1：跨狀態的唯一性用占用表——列存在即占用，核准時 INSERT、停用或去識別化時 DELETE。
 * 附錄 A 沒有給 `id` 欄，占用鍵本身就是主鍵。
 */
export const studentIdentities = pgTable(
  'student_identities',
  {
    cohortId: uuid('cohort_id')
      .notNull()
      .references(() => cohorts.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    studentNo: text('student_no').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    // 同屆有效學號唯一。
    primaryKey({ name: 'student_identities_pkey', columns: [t.cohortId, t.studentNo] }),
    // 一個人同時只占一個學號。
    unique('student_identities_user_unique').on(t.userId),
  ],
)

/** 一次名單匯入＝一個版本（附錄 A `roster_versions`；不可變）。 */
export const rosterVersions = pgTable('roster_versions', {
  id: uuid('id').primaryKey(),
  cohortId: uuid('cohort_id')
    .notNull()
    .references(() => cohorts.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
  importedByUserId: uuid('imported_by_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
  importedRealAt: timestamp('imported_real_at', tz).notNull(),
  /** 預覽結果：總筆數、有效、重複、缺欄、衝突。 */
  summary: jsonb('summary').notNull(),
  /** 原始 CSV（`purpose='roster_csv'`）；表在同一支 migration 裡先建。 */
  fileId: uuid('file_id').references(() => storedFiles.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
})

/** 名單的每一列（附錄 A `roster_entries`；不可變）。 */
export const rosterEntries = pgTable(
  'roster_entries',
  {
    id: uuid('id').primaryKey(),
    rosterVersionId: uuid('roster_version_id')
      .notNull()
      .references(() => rosterVersions.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    studentNo: text('student_no').notNull(),
    nameRaw: text('name_raw').notNull(),
    nameNormalized: text('name_normalized').notNull(),
    /** CSV 帶進來的系級；舊三欄 CSV 沒有這欄就留白（2026-09-15 定案，#51 會用）。 */
    departmentClass: text('department_class'),
    email: text('email'),
    conflictFlag: text('conflict_flag'),
  },
  (t) => [
    unique('roster_entries_identity').on(t.rosterVersionId, t.studentNo),
    check(
      'roster_entries_conflict_flag_check',
      sql`${t.conflictFlag} is null or ${t.conflictFlag} in ('duplicate','name_mismatch','missing_name')`,
    ),
  ],
)

/** 註冊申請頭列（附錄 A `registration_applications`）。 */
export const registrationApplications = pgTable(
  'registration_applications',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    revision: integer('revision').notNull().default(1),
    appliedName: text('applied_name').notNull(),
    studentNo: text('student_no').notNull(),
    /** 申請人填的系級；與屆別分開，缺值留白（2026-09-15 定案）。 */
    departmentClass: text('department_class'),
    phone: text('phone').notNull(),
    contactEmail: text('contact_email').notNull(),
    loginEmail: text('login_email').notNull(),
    rosterVersionId: uuid('roster_version_id').references(() => rosterVersions.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    /** 只協助審核，不改狀態（模組 01 §2）。結構：matched、entry、emailComparison、flags。 */
    rosterMatch: jsonb('roster_match').notNull().default(sql`'{}'::jsonb`),
    state: text('state').notNull().default('pending'),
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    decidedRealAt: timestamp('decided_real_at', tz),
    verificationMethod: text('verification_method'),
    verificationNote: text('verification_note'),
    reason: text('reason'),
    assignedCohortId: uuid('assigned_cohort_id').references(() => cohorts.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
  },
  (t) => [
    check('registration_applications_state_check', sql`${t.state} in ('pending','approved','rejected')`),
    check(
      'registration_applications_verification_method_check',
      sql`${t.verificationMethod} is null or ${t.verificationMethod} in ('id_document','school_channel','other')`,
    ),
    // 核准必記核實方式（模組 01 §2）。
    check(
      'registration_applications_approved_verification_check',
      sql`${t.state} <> 'approved' or ${t.verificationMethod} is not null`,
    ),
    // 核實方式選 other 時必須寫說明。
    check(
      'registration_applications_other_note_check',
      sql`${t.verificationMethod} is distinct from 'other' or ${t.verificationNote} is not null`,
    ),
    // 一次只能有一筆待審。
    uniqueIndex('registration_applications_one_pending')
      .on(t.userId)
      .where(sql`${t.state} = 'pending'`),
    index('registration_applications_state_created_idx').on(t.state, t.createdAt),
  ],
)

/** 每次修改的快照（附錄 A `application_revisions`；不可變）。系級的修改歷史也存在 snapshot 裡。 */
export const applicationRevisions = pgTable(
  'application_revisions',
  {
    id: uuid('id').primaryKey(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => registrationApplications.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    revision: integer('revision').notNull(),
    /** 當時的申請資料與比對結果（含 `departmentClass`）。 */
    snapshot: jsonb('snapshot').notNull(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [unique('application_revisions_identity').on(t.applicationId, t.revision)],
)

/** 角色的有效區間列（附錄 A `role_assignments`）。 */
export const roleAssignments = pgTable(
  'role_assignments',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    role: text('role').notNull(),
    grantedByUserId: uuid('granted_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    grantedRealAt: timestamp('granted_real_at', tz).notNull(),
    revokedByUserId: uuid('revoked_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    revokedRealAt: timestamp('revoked_real_at', tz),
    reason: text('reason'),
  },
  (t) => [
    check('role_assignments_role_check', sql`${t.role} in ('student','teacher','admin')`),
    // 同一個角色同時只有一筆有效。
    uniqueIndex('role_assignments_one_active')
      .on(t.userId, t.role)
      .where(sql`${t.revokedRealAt} is null`),
    index('role_assignments_user_idx').on(t.userId),
  ],
)

/** 帳號狀態變更的流水（附錄 A `user_status_events`；不可變）。 */
export const userStatusEvents = pgTable(
  'user_status_events',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    fromStatus: text('from_status').notNull(),
    toStatus: text('to_status').notNull(),
    reason: text('reason'),
    verificationMethod: text('verification_method'),
    actorKind: text('actor_kind').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    realAt: timestamp('real_at', tz).notNull(),
  },
  (t) => [
    check(
      'user_status_events_from_status_check',
      sql`${t.fromStatus} in ('pending','active','disabled','deidentified')`,
    ),
    check(
      'user_status_events_to_status_check',
      sql`${t.toStatus} in ('pending','active','disabled','deidentified')`,
    ),
    check(
      'user_status_events_verification_method_check',
      sql`${t.verificationMethod} is null or ${t.verificationMethod} in ('id_document','school_channel','other')`,
    ),
    check('user_status_events_actor_kind_check', sql`${t.actorKind} in ('user','system','worker')`),
    check(
      'user_status_events_actor_check',
      sql`(${t.actorKind} = 'user') = (${t.actorUserId} is not null)`,
    ),
    index('user_status_events_user_real_at_idx').on(t.userId, t.realAt),
  ],
)

/**
 * 撤 session 的可變工作列（附錄 A `session_revocations`；v2.4）。
 *
 * 一個狀態事件一筆**主工作**（`trigger='status_event'`），核對不一致時再排**收斂工作**
 * （`trigger='reconcile'`）。執行器與收斂邏輯在後面的票；這張票只建表與三條部分唯一鍵。
 */
export const sessionRevocations = pgTable(
  'session_revocations',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    /** 收斂工作也指向該使用者當時最新的狀態事件，不為收斂製造假狀態事件。 */
    statusEventId: uuid('status_event_id')
      .notNull()
      .references(() => userStatusEvents.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    trigger: text('trigger').notNull().default('status_event'),
    reconcileReason: text('reconcile_reason'),
    reconcileOfId: uuid('reconcile_of_id').references((): AnyPgColumn => sessionRevocations.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    reconcileRound: integer('reconcile_round').notNull().default(0),
    kind: text('kind').notNull(),
    state: text('state').notNull().default('queued'),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', tz),
    /** 租約過期或逾時＝外部結果未知；讓這個人留在 7 天的收斂觀察集合裡。 */
    outcomeUnknown: boolean('outcome_unknown').notNull().default(false),
    expectedUserStatus: text('expected_user_status').notNull(),
    cancelReason: text('cancel_reason'),
    lastError: text('last_error'),
    requestedRealAt: timestamp('requested_real_at', tz).notNull(),
    completedRealAt: timestamp('completed_real_at', tz),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
  },
  (t) => [
    check('session_revocations_trigger_check', sql`${t.trigger} in ('status_event','reconcile')`),
    check(
      'session_revocations_reconcile_reason_check',
      sql`${t.reconcileReason} is null or ${t.reconcileReason} in ('after_completion','periodic','manual_retry')`,
    ),
    check(
      'session_revocations_reconcile_reason_pairing_check',
      sql`(${t.trigger} = 'reconcile') = (${t.reconcileReason} is not null)`,
    ),
    check(
      'session_revocations_reconcile_of_pairing_check',
      sql`(${t.trigger} = 'reconcile') = (${t.reconcileOfId} is not null)`,
    ),
    check(
      'session_revocations_reconcile_round_check',
      sql`(${t.trigger} = 'status_event' and ${t.reconcileRound} = 0) or (${t.trigger} = 'reconcile' and ${t.reconcileRound} >= 1)`,
    ),
    check('session_revocations_kind_check', sql`${t.kind} in ('ban','unban','revoke_all')`),
    check(
      'session_revocations_state_check',
      sql`${t.state} in ('queued','executing','done','failed','cancelled')`,
    ),
    check(
      'session_revocations_expected_user_status_check',
      sql`${t.expectedUserStatus} in ('disabled','active','deidentified')`,
    ),
    // executing 一定要有租約（附錄 A：executing 時兩欄 NOT NULL）。
    check(
      'session_revocations_lease_check',
      sql`${t.state} <> 'executing' or (${t.leaseOwner} is not null and ${t.leaseExpiresAt} is not null)`,
    ),
    // ① 一個狀態事件只有一筆主工作。
    uniqueIndex('session_revocations_one_main_per_event')
      .on(t.statusEventId)
      .where(sql`${t.trigger} = 'status_event'`),
    // ② 每人同時最多一筆在執行。
    uniqueIndex('session_revocations_one_executing_per_user')
      .on(t.userId)
      .where(sql`${t.state} = 'executing'`),
    // ③ 每人同時最多一筆未結的收斂工作＝收斂插入的冪等鍵。
    uniqueIndex('session_revocations_one_open_reconcile_per_user')
      .on(t.userId)
      .where(sql`${t.trigger} = 'reconcile' and ${t.state} in ('queued','executing')`),
    index('session_revocations_state_requested_idx').on(t.state, t.requestedRealAt),
    index('session_revocations_user_state_idx').on(t.userId, t.state),
    index('session_revocations_user_event_round_idx').on(t.userId, t.statusEventId, t.reconcileRound),
  ],
)
