import 'server-only'
import { sql } from 'drizzle-orm'
import { bigint, check, index, pgTable, text, timestamp, uniqueIndex, uuid, integer } from 'drizzle-orm/pg-core'
import { users } from '@/infrastructure/db/schema/auth'
import { cohorts } from '@/infrastructure/db/schema/base'

/**
 * 模組 10 的最小檔案能力（附錄 A `stored_files`、`file_references`）。
 *
 * 契約 01 §12 要求 S01 這支 migration 先建這兩張表、再建 `roster_versions`，
 * 因為名單原檔的 FK 指過來。S07（票 21，0008）只加 GC 相關索引，不動欄位。
 */

const tz = { withTimezone: true } as const

export const storedFiles = pgTable(
  'stored_files',
  {
    id: uuid('id').primaryKey(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    scope: text('scope').notNull(),
    cohortId: uuid('cohort_id').references(() => cohorts.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    purpose: text('purpose').notNull(),
    originalName: text('original_name').notNull(),
    // 檔案大小可能超過 int4；`mode: 'number'` 讓它以 JS number 讀回（上限遠大於實際檔案）。
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    mimeDeclared: text('mime_declared').notNull(),
    mimeDetected: text('mime_detected'),
    extension: text('extension').notNull(),
    checksum: text('checksum'),
    status: text('status').notNull().default('uploading'),
    storageKey: text('storage_key').notNull().unique(),
    uploadedRealAt: timestamp('uploaded_real_at', tz).notNull(),
    finalizedAt: timestamp('finalized_at', tz),
    softDeletedAt: timestamp('soft_deleted_at', tz),
    purgedAt: timestamp('purged_at', tz),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
  },
  (t) => [
    check('stored_files_scope_check', sql`${t.scope} in ('cohort','global')`),
    check('stored_files_scope_cohort_check', sql`(${t.scope} = 'cohort') = (${t.cohortId} is not null)`),
    check(
      'stored_files_purpose_check',
      sql`${t.purpose} in ('submission','attachment','roster_csv','advisor_csv','poster','photo','export','signoff_attachment')`,
    ),
    check(
      'stored_files_status_check',
      sql`${t.status} in ('uploading','stored','soft_deleted','purged')`,
    ),
    // 附錄 A：`stored` 狀態才要求大小與 checksum（上傳中還沒算完）。
    check(
      'stored_files_stored_requires_size_check',
      sql`${t.status} <> 'stored' or ${t.sizeBytes} is not null`,
    ),
    check(
      'stored_files_stored_requires_checksum_check',
      sql`${t.status} <> 'stored' or ${t.checksum} is not null`,
    ),
    index('stored_files_status_finalized_idx').on(t.status, t.finalizedAt),
    index('stored_files_owner_idx').on(t.ownerUserId),
    // 回收索引（票 21，S07；模組 10 §2：GC 只碰超過 24 小時的 uploading 殘留、7 天後永久刪除軟刪除檔）。
    // 上傳中斷、類型不符、太大時暫存檔當場刪，`uploading` 列留給回收，靠這兩條找得到，不用掃整張表。
    index('stored_files_uploading_gc_idx')
      .on(t.uploadedRealAt)
      .where(sql`${t.status} = 'uploading'`),
    index('stored_files_soft_deleted_gc_idx')
      .on(t.softDeletedAt)
      .where(sql`${t.status} = 'soft_deleted'`),
  ],
)

export const fileReferences = pgTable(
  'file_references',
  {
    id: uuid('id').primaryKey(),
    fileId: uuid('file_id')
      .notNull()
      .references(() => storedFiles.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    refType: text('ref_type').notNull(),
    refId: uuid('ref_id').notNull(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    releasedAt: timestamp('released_at', tz),
  },
  (t) => [
    check(
      'file_references_ref_type_check',
      sql`${t.refType} in ('draft','submission_version','item_attachment','signoff_version','showcase_version','showcase_draft','export','roster_version')`,
    ),
    // 契約 01 §11：同一引用者同時只有一筆有效引用；釋放後可以再插新列。
    uniqueIndex('file_references_active_ref')
      .on(t.fileId, t.refType, t.refId)
      .where(sql`${t.releasedAt} is null`),
    index('file_references_ref_idx').on(t.refType, t.refId).where(sql`${t.releasedAt} is null`),
    index('file_references_file_idx').on(t.fileId).where(sql`${t.releasedAt} is null`),
  ],
)
