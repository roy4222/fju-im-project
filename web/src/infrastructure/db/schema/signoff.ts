import 'server-only'
import { sql } from 'drizzle-orm'
import { check, index, integer, jsonb, pgTable, text, timestamp, unique, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core'
import { users } from '@/infrastructure/db/schema/auth'
import { cohorts, domainEvents } from '@/infrastructure/db/schema/base'
import { storedFiles } from '@/infrastructure/db/schema/files'
import { groups } from '@/infrastructure/db/schema/groups'

/**
 * 模組 07 線上簽核的五張表（模組實作設計 07 附錄 A；第十一支 migration，票 25／切片 S11）。
 *
 * 票 26（逐人同意、老師同意、重置、作廢、匯出、提醒）在開發計畫標「改資料庫結構：否」，資料庫線也只有這一支輪得到它，
 * 所以五張一次建好：票 25 只寫簽核包、版本內容、版本狀態（建版、內容變更與成員變更的失效）；
 * `approvals`、`signoff_exports` 由票 26 開始寫。
 *
 * 分表的理由（附錄 A v3.2）：`signoff_package_versions` 只存**不可變**內容（全文、checksum、附件版本、參與者、
 * 授權範圍），狀態另放可變頭列 `signoff_version_status`。狀態怎麼改都不會碰到大家同意的那份內容。
 *
 * 和附錄 A 不同的地方（都是「多記、不少記」）：
 * - `signoff_packages` 多 `created_at`、`created_by_user_id`、`updated_at`、`updated_by_user_id`（通用欄，契約 01 §1）。
 * - `signoff_version_status` 多 `created_at`、`updated_by_user_id`。
 * - 版本內容多一條 CHECK：`content_checksum` 一定等於 `content_text` 的 sha256（資料庫自己算，不信任程式傳來的值）。
 *
 * 資料庫守的規則（用例之外的第二層）：
 * - 版本內容、同意紀錄、匯出紀錄不可變（產生器的 trigger，連 owner 也擋）。
 * - `final_document` 的版本一定帶授權範圍、`result_confirmation` 一定不帶（0010 檔尾手寫 trigger）。
 * - 版本狀態：新建只能是 collecting；`void` 是終點，`superseded` 只能再作廢；指向的版本不能改；不能刪（手寫 trigger）。
 *   其他轉換（collecting → teacher_pending → complete、退回）由用例判——附錄 A「由 domain 驗證，DB 只擋非法值」。
 * - 一人一票：`approvals` 唯一 `(version_id, user_id)`；學生只有同意／不同意、主指導只有同意／退回；
 *   不同意與退回一定有理由；老師沒有學號。
 */

const tz = { withTimezone: true } as const
const restrict = { onDelete: 'restrict', onUpdate: 'restrict' } as const

/** 簽核用途（附錄 A `signoff_packages.purpose`；產品 8.3 v1 類型）。 */
const PURPOSES = sql.raw(`('final_document','result_confirmation')`)

/** 版本狀態（附錄 A `signoff_version_status.state`）。 */
const STATES = sql.raw(`('collecting','teacher_pending','complete','revision','superseded','void')`)

/** 一組一個用途一個簽核包（頭列）；`current_version_id` 指目前這一版。 */
export const signoffPackages = pgTable(
  'signoff_packages',
  {
    id: uuid('id').primaryKey(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, restrict),
    cohortId: uuid('cohort_id')
      .notNull()
      .references(() => cohorts.id, restrict),
    purpose: text('purpose').notNull(),
    /** 目前這一版；建版時切換。 */
    currentVersionId: uuid('current_version_id').references((): AnyPgColumn => signoffPackageVersions.id, restrict),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, restrict),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, restrict),
  },
  (t) => [
    unique('signoff_packages_group_purpose_unique').on(t.groupId, t.purpose),
    index('signoff_packages_cohort_idx').on(t.cohortId),
    check('signoff_packages_purpose_check', sql`${t.purpose} in ${PURPOSES}`),
    check('signoff_packages_revision_check', sql`${t.revision} >= 1`),
  ],
)

/**
 * 簽核版本的內容（附錄 A `signoff_package_versions`；**不可變**）。改全文、換成員或換主指導都是新的一列。
 *
 * - `content_text`：清洗過的受限 HTML（和公告正文同一份白名單）。
 * - `attachment_file_versions`：`[{ fileId, checksum, name }]`，綁建版當下的檔案版本。
 * - `participants`：`{ students: [{ userId, displayName, studentNo, membershipId }], advisor: { userId, displayName, assignmentId } }`。
 * - `supersede_cause`：這一版是因為什麼而建（第一版是 NULL）。
 * - `authorization_scope`：`final_document` 才有，從精選草稿凍結（見 `application/signoff/scope.ts`）。
 */
export const signoffPackageVersions = pgTable(
  'signoff_package_versions',
  {
    id: uuid('id').primaryKey(),
    packageId: uuid('package_id')
      .notNull()
      .references(() => signoffPackages.id, restrict),
    versionNo: integer('version_no').notNull(),
    contentText: text('content_text').notNull(),
    contentChecksum: text('content_checksum').notNull(),
    attachmentFileVersions: jsonb('attachment_file_versions').notNull().default(sql`'[]'::jsonb`),
    participants: jsonb('participants').notNull(),
    supersedeCause: text('supersede_cause'),
    authorizationScope: jsonb('authorization_scope'),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, restrict),
    createdRealAt: timestamp('created_real_at', tz).notNull(),
    createdBusinessAt: timestamp('created_business_at', tz).notNull(),
  },
  (t) => [
    unique('signoff_package_versions_no_unique').on(t.packageId, t.versionNo),
    check('signoff_package_versions_version_no_check', sql`${t.versionNo} >= 1`),
    check('signoff_package_versions_content_check', sql`length(btrim(${t.contentText})) > 0`),
    check(
      'signoff_package_versions_checksum_check',
      sql`${t.contentChecksum} = encode(sha256(convert_to(${t.contentText}, 'UTF8')), 'hex')`,
    ),
    check('signoff_package_versions_attachments_check', sql`jsonb_typeof(${t.attachmentFileVersions}) = 'array'`),
    check(
      'signoff_package_versions_participants_check',
      sql`jsonb_typeof(${t.participants}) = 'object' and jsonb_typeof(${t.participants} -> 'students') = 'array'`,
    ),
    check(
      'signoff_package_versions_supersede_cause_check',
      sql`${t.supersedeCause} in ('member_change','advisor_change','content_change','reset')`,
    ),
    check(
      'signoff_package_versions_scope_check',
      sql`${t.authorizationScope} is null or jsonb_typeof(${t.authorizationScope}) = 'object'`,
    ),
  ],
)

/** 版本的狀態頭列（附錄 A `signoff_version_status`；可變，但 `void` 是終點、`superseded` 只能再作廢）。 */
export const signoffVersionStatus = pgTable(
  'signoff_version_status',
  {
    versionId: uuid('version_id')
      .primaryKey()
      .references(() => signoffPackageVersions.id, restrict),
    state: text('state').notNull(),
    /** 退回、失效或作廢的原因：member_change／advisor_change／content_change／reset 或管理員填的理由。 */
    cause: text('cause'),
    completedRealAt: timestamp('completed_real_at', tz),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, restrict),
  },
  (t) => [
    check('signoff_version_status_state_check', sql`${t.state} in ${STATES}`),
    check(
      'signoff_version_status_cause_check',
      sql`${t.state} not in ('revision','superseded','void') or length(btrim(coalesce(${t.cause}, ''))) > 0`,
    ),
    check(
      'signoff_version_status_completed_check',
      sql`${t.state} <> 'complete' or ${t.completedRealAt} is not null`,
    ),
    check('signoff_version_status_revision_check', sql`${t.revision} >= 1`),
  ],
)

/**
 * 每人一票的同意紀錄（附錄 A `approvals`；**不可變**；票 26 才寫）。
 * TS 名加前綴，免得和別的「approval」撞名；SQL 名照附錄 A。
 */
export const signoffApprovals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey(),
    versionId: uuid('version_id')
      .notNull()
      .references(() => signoffPackageVersions.id, restrict),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, restrict),
    role: text('role').notNull(),
    /** 當時姓名與學號（老師沒有學號）。 */
    displayNameAt: text('display_name_at').notNull(),
    studentNoAt: text('student_no_at'),
    result: text('result').notNull(),
    reason: text('reason'),
    /** 這次登入實際使用的方式（不從帳號綁定推論）。 */
    loginMethod: text('login_method').notNull(),
    /** 按鈕原文。 */
    buttonText: text('button_text').notNull(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => domainEvents.id, restrict),
    requestId: uuid('request_id').notNull(),
    realAt: timestamp('real_at', tz).notNull(),
    businessAt: timestamp('business_at', tz).notNull(),
  },
  (t) => [
    unique('approvals_one_vote').on(t.versionId, t.userId),
    check('approvals_role_check', sql`${t.role} in ('student','advisor')`),
    check(
      'approvals_result_check',
      sql`(${t.role} = 'student' and ${t.result} in ('agree','disagree'))
          or (${t.role} = 'advisor' and ${t.result} in ('agree','return'))`,
    ),
    check(
      'approvals_reason_check',
      sql`${t.result} = 'agree' or length(btrim(coalesce(${t.reason}, ''))) > 0`,
    ),
    check('approvals_student_no_check', sql`${t.role} = 'student' or ${t.studentNoAt} is null`),
    check('approvals_login_method_check', sql`${t.loginMethod} in ('google','password')`),
    check('approvals_button_text_check', sql`length(btrim(${t.buttonText})) > 0`),
  ],
)

/** 匯出紀錄（附錄 A `signoff_exports`；**不可變**；票 26 才寫）。 */
export const signoffExports = pgTable(
  'signoff_exports',
  {
    id: uuid('id').primaryKey(),
    versionId: uuid('version_id')
      .notNull()
      .references(() => signoffPackageVersions.id, restrict),
    format: text('format').notNull(),
    fileId: uuid('file_id')
      .notNull()
      .references(() => storedFiles.id, restrict),
    exportedByUserId: uuid('exported_by_user_id')
      .notNull()
      .references(() => users.id, restrict),
    realAt: timestamp('real_at', tz).notNull(),
  },
  (t) => [
    index('signoff_exports_version_idx').on(t.versionId, t.realAt),
    check('signoff_exports_format_check', sql`${t.format} in ('printable','csv')`),
  ],
)
