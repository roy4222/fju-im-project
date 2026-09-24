import 'server-only'
import { sql } from 'drizzle-orm'
import { boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { users } from '@/infrastructure/db/schema/auth'
import { storedFiles } from '@/infrastructure/db/schema/files'
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

/**
 * 每一次正式送出帶了哪些檔案（附錄 A `submission_files`，不可變；第九支 migration，票 21）。
 *
 * 一個檔案欄位一個檔（`answers[field_key]` 就是檔案 ID），所以 `(submission_version_id, field_key)` 也唯一。
 * `checksum` 抄送出當下 `stored_files.checksum`：之後就算檔案列被動過，也對得出那一版交的是哪一份位元組
 * （產品模組 05 SUB-09「第 1 次內容與 hash 不變」）。檔案本身另由 `file_references`（`submission_version`）保護不被回收。
 */
export const submissionFiles = pgTable(
  'submission_files',
  {
    submissionVersionId: uuid('submission_version_id')
      .notNull()
      .references(() => submissionVersions.id, restrict),
    fileId: uuid('file_id')
      .notNull()
      .references(() => storedFiles.id, restrict),
    fieldKey: text('field_key').notNull(),
    checksum: text('checksum').notNull(),
  },
  (t) => [
    primaryKey({ name: 'submission_files_pk', columns: [t.submissionVersionId, t.fileId] }),
    unique('submission_files_field_unique').on(t.submissionVersionId, t.fieldKey),
    check('submission_files_checksum_check', sql`${t.checksum} ~ '^[0-9a-f]{64}$'`),
    index('submission_files_file_idx').on(t.fileId),
  ],
)

/**
 * 主指導閱覽設定（附錄 A `advisor_visibility_settings`，不可變；票 21 建表）。
 *
 * 只插不改：每改一次設定插一列，「目前的設定」＝這個項目 `set_at` 最新的那一列；沒有任何一列＝沒開放。
 * `effective_from_version_no` 對的是**欄位版本**（`form_schema_versions.version_no`）：主指導只看得到
 * 用這個欄位版本以後送出的正式版本——學生填寫前看到「主指導可查看」的告知是跟著欄位版本走的，
 * 已經收到的舊回答不因為後來改設定而擴大給老師看（產品模組 05 §4「誰看得到個人回答」、SUB-24）。
 * 只管**個人回答**；組別正式版本的主指導閱覽看目前有效的指導關係（契約 03 §1）。
 */
export const advisorVisibilitySettings = pgTable(
  'advisor_visibility_settings',
  {
    id: uuid('id').primaryKey(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => managedItems.id, restrict),
    enabled: boolean('enabled').notNull(),
    effectiveFromVersionNo: integer('effective_from_version_no').notNull(),
    setByUserId: uuid('set_by_user_id')
      .notNull()
      .references(() => users.id, restrict),
    setAt: timestamp('set_at', tz).notNull(),
  },
  (t) => [
    check('advisor_visibility_settings_effective_check', sql`${t.effectiveFromVersionNo} >= 1`),
    index('advisor_visibility_settings_item_idx').on(t.itemId, t.setAt),
  ],
)
