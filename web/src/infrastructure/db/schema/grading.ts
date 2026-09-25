import 'server-only'
import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  jsonb,
  numeric,
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
import { groups } from '@/infrastructure/db/schema/groups'

/**
 * 模組 06 評分與成績的九張表（模組實作設計 06 附錄 A；第十支 migration，票 23／切片 S10）。
 *
 * 票 24（成績表、退回、更正、改派三選一、匯出）在開發計畫標「改資料庫結構：否」，資料庫線也只有這一支輪得到它，
 * 所以九張一次建好：票 23 只寫方案、要求份數、指派、暫存與正式送出；`grade_overrides`、`override_review_state`
 * 與指派的結束欄由票 24 開始寫。
 *
 * **評分方案的「階段」不是票 11 的屆別階段（`cohort_stages`）**：後者是年度時間軸（四段開始日），
 * 前者是「系統驗收」「專題發表」這種計分階段，存在方案版本的 `stages` jsonb 裡、各有自己的 `key`。
 * 要求份數與指派用 `stage_key` 指向方案裡的階段，不設 FK（jsonb 裡的東西沒辦法 FK；由用例核對）。
 *
 * 和附錄 A 不同的地方（照 0007 `advisor_assignments` 的做法，都是「多記、不少記」）：
 * - `evaluator_assignments` 多 `ended_real_at`、`ended_by_user_id`、`previous_assignment_id`、`created_at`、`updated_at`：
 *   移除／改派的時間與操作者記在被結束的那一列，改派時新列指向它接手的舊列（票 24 的三選一要用）。
 * - `evaluation_status_events.from_state` 可以是 NULL＝「建立」（同 `cohort_status_events`）。
 * - `grading_schemes`、`stage_requirements`、`evaluation_status`、`override_review_state` 帶通用欄（契約 01 §1）。
 * - 方案版本多 `created_at`、`created_by_user_id`（誰建的版本）。
 *
 * 資料庫守的規則（用例之外的第二層）：
 * - 同一指派最多一筆採計：`evaluation_status` 部分唯一 `(assignment_id) WHERE state='counted'`（母 spec §4.7）。
 * - 同組同階段同老師只有一筆有效指派：`evaluator_assignments` 部分唯一 `(group_id, stage_key, teacher_user_id) WHERE valid_to IS NULL`。
 * - 老師輸入（`evaluations`）、狀態紀錄、更正三張不可變；方案版本的內容不可改、狀態只前進；
 *   狀態頭列只允許規定的轉換——這幾條由 migration 裡手寫的 trigger 守（見 0009 檔尾）。
 */

const tz = { withTimezone: true } as const
const restrict = { onDelete: 'restrict', onUpdate: 'restrict' } as const

/** 評分狀態（附錄 A `evaluation_status.state`）。 */
const EVALUATION_STATES = sql.raw(`('draft','counted','historical','returned','invalidated')`)

/** 每屆一個評分方案（頭列）；版本在 `grading_scheme_versions`，`current_version_id` 指目前套用的那一版。 */
export const gradingSchemes = pgTable(
  'grading_schemes',
  {
    id: uuid('id').primaryKey(),
    cohortId: uuid('cohort_id')
      .notNull()
      .references(() => cohorts.id, restrict),
    name: text('name').notNull(),
    /** 目前套用的版本（發布時切換）；還沒發布過任何版本時是 null。 */
    currentVersionId: uuid('current_version_id').references((): AnyPgColumn => gradingSchemeVersions.id, restrict),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    createdByKind: text('created_by_kind').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, restrict),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, restrict),
  },
  (t) => [
    unique('grading_schemes_cohort_unique').on(t.cohortId),
    check('grading_schemes_name_check', sql`length(btrim(${t.name})) > 0`),
    check('grading_schemes_revision_check', sql`${t.revision} >= 1`),
    check('grading_schemes_created_by_kind_check', sql`${t.createdByKind} in ('user','system','worker')`),
    check(
      'grading_schemes_created_by_actor_check',
      sql`(${t.createdByKind} = 'user') = (${t.createdByUserId} is not null)`,
    ),
  ],
)

/**
 * 方案版本（附錄 A `grading_scheme_versions`）。`stages` 寫了就不動（trigger 擋），改結構＝建新版本。
 * 狀態只前進：draft → published → locked（第一位老師開始填——第一份暫存或正式送出——時鎖；產品 7.5）。權重合計由用例驗。
 */
export const gradingSchemeVersions = pgTable(
  'grading_scheme_versions',
  {
    id: uuid('id').primaryKey(),
    schemeId: uuid('scheme_id')
      .notNull()
      .references(() => gradingSchemes.id, restrict),
    versionNo: integer('version_no').notNull(),
    /** `[{ key, name, weight, letterMap?, items: [{ key, name, max, weight, type }] }]`。 */
    stages: jsonb('stages').notNull(),
    status: text('status').notNull().default('draft'),
    lockedAt: timestamp('locked_at', tz),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, restrict),
  },
  (t) => [
    unique('grading_scheme_versions_no_unique').on(t.schemeId, t.versionNo),
    check('grading_scheme_versions_status_check', sql`${t.status} in ('draft','published','locked')`),
    check('grading_scheme_versions_version_no_check', sql`${t.versionNo} >= 1`),
    check('grading_scheme_versions_stages_check', sql`jsonb_typeof(${t.stages}) = 'array'`),
    check('grading_scheme_versions_locked_at_check', sql`(${t.status} = 'locked') = (${t.lockedAt} is not null)`),
  ],
)

/** 每組每階段要幾份評分（附錄 A `stage_requirements`）：完成的分母。 */
export const stageRequirements = pgTable(
  'stage_requirements',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, restrict),
    stageKey: text('stage_key').notNull(),
    requiredCount: integer('required_count').notNull(),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, restrict),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, restrict),
  },
  (t) => [
    primaryKey({ name: 'stage_requirements_pk', columns: [t.groupId, t.stageKey] }),
    check('stage_requirements_required_count_check', sql`${t.requiredCount} >= 0`),
    check('stage_requirements_stage_key_check', sql`length(${t.stageKey}) between 1 and 40`),
    check('stage_requirements_revision_check', sql`${t.revision} >= 1`),
  ],
)

/**
 * 評分老師指派（附錄 A `evaluator_assignments`）：有效區間列。指派＝插一列；移除／改派（票 24）＝結束這一列。
 * `reason`、`removal_choice` 是**移除**時填的（附錄 A：欄級 UPDATE）。
 */
export const evaluatorAssignments = pgTable(
  'evaluator_assignments',
  {
    id: uuid('id').primaryKey(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, restrict),
    stageKey: text('stage_key').notNull(),
    teacherUserId: uuid('teacher_user_id')
      .notNull()
      .references(() => users.id, restrict),
    /** 業務時間。 */
    validFrom: timestamp('valid_from', tz).notNull(),
    validTo: timestamp('valid_to', tz),
    /** 移除時管理員選的採計方式：保留已完成評分／替換重評／明確新增（產品 7.4 Q-GRP01）。 */
    removalChoice: text('removal_choice'),
    /** 移除理由。 */
    reason: text('reason'),
    assignedByUserId: uuid('assigned_by_user_id')
      .notNull()
      .references(() => users.id, restrict),
    /** 改派時：這一列接手的舊指派。 */
    previousAssignmentId: uuid('previous_assignment_id').references((): AnyPgColumn => evaluatorAssignments.id, restrict),
    endedRealAt: timestamp('ended_real_at', tz),
    endedByUserId: uuid('ended_by_user_id').references(() => users.id, restrict),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('evaluator_assignments_one_active')
      .on(t.groupId, t.stageKey, t.teacherUserId)
      .where(sql`${t.validTo} is null`),
    index('evaluator_assignments_group_idx').on(t.groupId, t.stageKey),
    index('evaluator_assignments_teacher_active_idx')
      .on(t.teacherUserId)
      .where(sql`${t.validTo} is null`),
    check('evaluator_assignments_stage_key_check', sql`length(${t.stageKey}) between 1 and 40`),
    check('evaluator_assignments_removal_choice_check', sql`${t.removalChoice} in ('keep','replace','add')`),
    check('evaluator_assignments_valid_range_check', sql`${t.validTo} is null or ${t.validTo} >= ${t.validFrom}`),
    check(
      'evaluator_assignments_ended_check',
      sql`(${t.validTo} is null) = (${t.endedRealAt} is null)
          and (${t.validTo} is null or length(btrim(coalesce(${t.reason}, ''))) > 0)
          and (${t.removalChoice} is null or ${t.validTo} is not null)`,
    ),
    check('evaluator_assignments_revision_check', sql`${t.revision} >= 1`),
  ],
)

/**
 * 老師輸入的分數（附錄 A `evaluations`；**不可變**）。每次暫存插一列 `draft`（最新的那一列就是目前的暫存），
 * 正式送出插一列 `final`。`scores` 是 `{ 項目 key: 數字 | 等第 | 'pass'/'fail' }`。
 */
export const evaluations = pgTable(
  'evaluations',
  {
    id: uuid('id').primaryKey(),
    assignmentId: uuid('assignment_id')
      .notNull()
      .references(() => evaluatorAssignments.id, restrict),
    kind: text('kind').notNull(),
    schemeVersionId: uuid('scheme_version_id')
      .notNull()
      .references(() => gradingSchemeVersions.id, restrict),
    scores: jsonb('scores').notNull(),
    submittedRealAt: timestamp('submitted_real_at', tz).notNull(),
    submittedBusinessAt: timestamp('submitted_business_at', tz).notNull(),
    requestId: uuid('request_id').notNull(),
  },
  (t) => [
    index('evaluations_assignment_idx').on(t.assignmentId, t.submittedRealAt),
    check('evaluations_kind_check', sql`${t.kind} in ('draft','final')`),
    check('evaluations_scores_check', sql`jsonb_typeof(${t.scores}) = 'object'`),
  ],
)

/** 評分的狀態頭列（附錄 A `evaluation_status`；可變，但只允許規定的轉換，trigger 守）。 */
export const evaluationStatus = pgTable(
  'evaluation_status',
  {
    evaluationId: uuid('evaluation_id')
      .primaryKey()
      .references(() => evaluations.id, restrict),
    assignmentId: uuid('assignment_id')
      .notNull()
      .references(() => evaluatorAssignments.id, restrict),
    state: text('state').notNull(),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, restrict),
  },
  (t) => [
    uniqueIndex('evaluation_status_one_counted')
      .on(t.assignmentId)
      .where(sql`${t.state} = 'counted'`),
    index('evaluation_status_assignment_idx').on(t.assignmentId),
    check('evaluation_status_state_check', sql`${t.state} in ${EVALUATION_STATES}`),
    check('evaluation_status_revision_check', sql`${t.revision} >= 1`),
  ],
)

/** 評分狀態的每一次變化（附錄 A `evaluation_status_events`；不可變）。`from_state` NULL＝建立。 */
export const evaluationStatusEvents = pgTable(
  'evaluation_status_events',
  {
    id: uuid('id').primaryKey(),
    evaluationId: uuid('evaluation_id')
      .notNull()
      .references(() => evaluations.id, restrict),
    fromState: text('from_state'),
    toState: text('to_state').notNull(),
    reason: text('reason'),
    actorKind: text('actor_kind').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, restrict),
    realAt: timestamp('real_at', tz).notNull(),
  },
  (t) => [
    index('evaluation_status_events_evaluation_idx').on(t.evaluationId, t.realAt),
    check(
      'evaluation_status_events_state_check',
      sql`${t.toState} in ${EVALUATION_STATES} and (${t.fromState} is null or ${t.fromState} in ${EVALUATION_STATES})`,
    ),
    check(
      'evaluation_status_events_returned_reason_check',
      sql`${t.toState} <> 'returned' or length(btrim(coalesce(${t.reason}, ''))) > 0`,
    ),
    check('evaluation_status_events_actor_kind_check', sql`${t.actorKind} in ('user','system','worker')`),
    check('evaluation_status_events_actor_check', sql`(${t.actorKind} = 'user') = (${t.actorUserId} is not null)`),
  ],
)

/** 管理員對最終結果的更正（附錄 A `grade_overrides`；不可變；票 24 才寫）。 */
export const gradeOverrides = pgTable(
  'grade_overrides',
  {
    id: uuid('id').primaryKey(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, restrict),
    schemeVersionId: uuid('scheme_version_id')
      .notNull()
      .references(() => gradingSchemeVersions.id, restrict),
    originalValue: numeric('original_value', { precision: 10, scale: 4 }).notNull(),
    newValue: numeric('new_value', { precision: 10, scale: 4 }).notNull(),
    /** 採計分數集合的 hash；之後算出來不一樣就進「待復核」。 */
    basisHash: text('basis_hash').notNull(),
    reason: text('reason').notNull(),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id, restrict),
    realAt: timestamp('real_at', tz).notNull(),
  },
  (t) => [
    index('grade_overrides_group_idx').on(t.groupId, t.realAt),
    check('grade_overrides_reason_check', sql`length(btrim(${t.reason})) > 0`),
  ],
)

/** 更正的復核狀態（附錄 A `override_review_state`；可變頭列；票 24 才寫）。 */
export const overrideReviewState = pgTable(
  'override_review_state',
  {
    overrideId: uuid('override_id')
      .primaryKey()
      .references(() => gradeOverrides.id, restrict),
    state: text('state').notNull().default('effective'),
    resolvedByUserId: uuid('resolved_by_user_id').references(() => users.id, restrict),
    resolvedAt: timestamp('resolved_at', tz),
    revision: integer('revision').notNull().default(1),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (t) => [
    check('override_review_state_state_check', sql`${t.state} in ('effective','pending_review','superseded')`),
    check('override_review_state_revision_check', sql`${t.revision} >= 1`),
  ],
)
