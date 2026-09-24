import 'server-only'
import { sql } from 'drizzle-orm'
import { check, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { users } from '@/infrastructure/db/schema/auth'
import { formSchemaVersions, managedItems } from '@/infrastructure/db/schema/items'

/**
 * 模組 05 個人與組別繳交的兩張回答表（模組實作設計 05 附錄 A `drafts`、`submission_versions`；第六支 migration，票 17）。
 *
 * 通用規則同契約 01 §1：uuid 主鍵、列舉用 CHECK、timestamptz、FK RESTRICT、可變頭列帶 revision。
 *
 * - `submission_drafts`：每個收件者（人或組）在一個項目上**一份**草稿，可變，靠 `revision` 做樂觀鎖——
 *   兩個分頁或兩台裝置同時改，後存的那一邊版本號對不上就被拒絕，不無聲覆蓋。
 *   附錄 A 叫 `drafts`；這裡加上 `submission_` 前綴，免得和之後精選（模組 07）的草稿搞混。
 * - `submission_versions`：每次正式送出一列，**不可變**（不給 UPDATE／DELETE，另掛 trigger）。
 *   版本號在草稿列鎖內分配（`coalesce(max)+1`），唯一鍵再擋一次。
 *
 * 組別收件、附件、欄位改版的欄位（`file_ids`、`legacy_answers`、`migration_state`、`membership_snapshot`、
 * `advisor_snapshot`）照附錄 A 先建好，票 17 只用個人收件（`receiver_kind='user'`）；
 * 組別共用草稿、上傳與主指導閱覽在票 21 接上，不用再改表。
 */

const tz = { withTimezone: true } as const
const restrict = { onDelete: 'restrict', onUpdate: 'restrict' } as const

/** 收件者的草稿（附錄 A `drafts`）。`receiver_id` 依 `receiver_kind` 指 users 或 groups，不設 FK（附錄 A：用例檢查）。 */
export const submissionDrafts = pgTable(
  'submission_drafts',
  {
    id: uuid('id').primaryKey(),
    itemId: uuid('item_id').notNull().references(() => managedItems.id, restrict),
    receiverKind: text('receiver_kind').notNull(),
    receiverId: uuid('receiver_id').notNull(),
    /** 草稿是照哪一版欄位填的（收件欄位改版時用來判斷要不要重新確認）。 */
    schemaVersionId: uuid('schema_version_id').notNull().references(() => formSchemaVersions.id, restrict),
    /** `{ 欄位代號: 字串 | 字串陣列 }`；只存輸入欄位。 */
    answers: jsonb('answers').notNull().default(sql`'{}'::jsonb`),
    /** 欄位改版後消失的欄位值（S08 改結構時保留；票 17 一律 NULL）。 */
    legacyAnswers: jsonb('legacy_answers'),
    /** 附件引用（票 21 上傳時用；附上時驗證）。 */
    fileIds: uuid('file_ids').array().notNull().default(sql`'{}'::uuid[]`),
    migrationState: text('migration_state').notNull().default('none'),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    createdByKind: text('created_by_kind').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, restrict),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, restrict),
  },
  (t) => [
    unique('submission_drafts_receiver_unique').on(t.itemId, t.receiverKind, t.receiverId),
    check('submission_drafts_receiver_kind_check', sql`${t.receiverKind} in ('user','group')`),
    check('submission_drafts_answers_check', sql`jsonb_typeof(${t.answers}) = 'object'`),
    check('submission_drafts_migration_state_check', sql`${t.migrationState} in ('none','auto','needs_review')`),
    check('submission_drafts_revision_check', sql`${t.revision} >= 1`),
    check('submission_drafts_created_by_kind_check', sql`${t.createdByKind} in ('user','system','worker')`),
    check(
      'submission_drafts_created_by_actor_check',
      sql`(${t.createdByKind} = 'user') = (${t.createdByUserId} is not null)`,
    ),
  ],
)

/**
 * 正式送出的版本（附錄 A `submission_versions`，不可變）。
 *
 * 準時與否看 `received_business_at`（後端收到完整請求的業務時間，母 spec §4.11）；
 * `request_id` 追溯帳本，`(submitted_by_user_id, request_id)` 唯一——同一次送出連點或重送，資料庫層也只可能有一列。
 */
export const submissionVersions = pgTable(
  'submission_versions',
  {
    id: uuid('id').primaryKey(),
    itemId: uuid('item_id').notNull().references(() => managedItems.id, restrict),
    receiverKind: text('receiver_kind').notNull(),
    receiverId: uuid('receiver_id').notNull(),
    versionNo: integer('version_no').notNull(),
    schemaVersionId: uuid('schema_version_id').notNull().references(() => formSchemaVersions.id, restrict),
    answers: jsonb('answers').notNull(),
    submittedByUserId: uuid('submitted_by_user_id').notNull().references(() => users.id, restrict),
    receivedRealAt: timestamp('received_real_at', tz).notNull(),
    receivedBusinessAt: timestamp('received_business_at', tz).notNull(),
    requestId: uuid('request_id').notNull(),
    /** 組別送出當下的有效成員 ID（組別收件必填，票 21）。 */
    membershipSnapshot: jsonb('membership_snapshot'),
    /** 送出當下的主指導（主指導閱覽，票 21）。 */
    advisorSnapshot: jsonb('advisor_snapshot'),
    /** 送出當下項目的期限版本（截止快照對帳用）。 */
    deadlineVersionAtSubmit: integer('deadline_version_at_submit').notNull(),
  },
  (t) => [
    unique('submission_versions_receiver_version_unique').on(t.itemId, t.receiverKind, t.receiverId, t.versionNo),
    unique('submission_versions_request_unique').on(t.submittedByUserId, t.requestId),
    check('submission_versions_receiver_kind_check', sql`${t.receiverKind} in ('user','group')`),
    check('submission_versions_version_no_check', sql`${t.versionNo} >= 1`),
    check('submission_versions_answers_check', sql`jsonb_typeof(${t.answers}) = 'object'`),
    check(
      'submission_versions_membership_check',
      sql`(${t.receiverKind} = 'group') = (${t.membershipSnapshot} is not null)`,
    ),
    check('submission_versions_deadline_version_check', sql`${t.deadlineVersionAtSubmit} >= 1`),
    index('submission_versions_item_idx').on(t.itemId),
  ],
)
