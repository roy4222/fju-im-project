import 'server-only'
import { sql } from 'drizzle-orm'
import {
  check,
  integer,
  jsonb,
  pgTable,
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
import { groups } from '@/infrastructure/db/schema/groups'

/**
 * 模組 09 精選的最小三張表（模組實作設計 09 附錄 A、§12「S11 交付最小草稿能力」；0010，票 25）。
 *
 * - `showcase_entries`：一組一屆一個精選條目（頭列）。歷屆補登（S12）沒有組別，`group_id` 可以是 NULL。
 * - `showcase_drafts`：可變草稿，一個條目一份；**儲存不需要授權**（草稿可以在簽核之前就存在，
 *   「最終文件授權」的簽核版本建版時從這份草稿凍結授權範圍）。
 * - `showcase_versions`：發布時凍結的不可變版本。**S11 只建空表**（`showcase_entries.current_version_id` 的 FK 目標），
 *   發布、閘門、核閱、公開頁都在 S12。
 *
 * `authorization_ref` 是多型參照（signoff → `signoff_package_versions.id`；external → S12 的 `external_authorizations.id`），
 * 不設 FK，由用例驗（附錄 A）。
 *
 * 和附錄 A 不同的地方：`showcase_entries` 多 `created_at`、`created_by_user_id`、`updated_by_user_id`；
 * `showcase_drafts` 多 `created_at`；多幾條 CHECK（海報檔與 checksum 成對、授權種類與參照成對、影片連結是 http(s)、
 * 長度上限、「發布中」一定有目前版本）。
 */

const tz = { withTimezone: true } as const
const restrict = { onDelete: 'restrict', onUpdate: 'restrict' } as const

/** 題目、摘要、影片連結的長度上限（和 `application/showcase` 的 `SHOWCASE_LIMITS` 同一組數字；資料庫再擋一次）。 */
const SHOWCASE_LIMITS = { title: 200, summary: 2000, videoUrl: 500 } as const

const VIDEO_URL = sql.raw(`'^https?://[^[:space:]]+$'`)

/** 精選條目（頭列）。 */
export const showcaseEntries = pgTable(
  'showcase_entries',
  {
    id: uuid('id').primaryKey(),
    cohortId: uuid('cohort_id')
      .notNull()
      .references(() => cohorts.id, restrict),
    /** 歷屆補登（S12）可以沒有組別。 */
    groupId: uuid('group_id').references(() => groups.id, restrict),
    status: text('status').notNull().default('draft'),
    /** 已發布才有（S12）。 */
    currentVersionId: uuid('current_version_id').references((): AnyPgColumn => showcaseVersions.id, restrict),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, restrict),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, restrict),
  },
  (t) => [
    // 同一組同一屆只能有一個精選條目（S11-03「再對 G1 建立第二份草稿 → 被拒」）。
    uniqueIndex('showcase_entries_one_per_group')
      .on(t.cohortId, t.groupId)
      .where(sql`${t.groupId} is not null`),
    check('showcase_entries_status_check', sql`${t.status} in ('draft','published','withdrawn')`),
    check(
      'showcase_entries_published_check',
      sql`${t.status} <> 'published' or ${t.currentVersionId} is not null`,
    ),
    check('showcase_entries_revision_check', sql`${t.revision} >= 1`),
  ],
)

/** 發布時從草稿凍結的不可變版本（S11 只建空表）。 */
export const showcaseVersions = pgTable(
  'showcase_versions',
  {
    id: uuid('id').primaryKey(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => showcaseEntries.id, restrict),
    versionNo: integer('version_no').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    /** sha256(正規化後的摘要)，給授權範圍比對。 */
    summaryChecksum: text('summary_checksum').notNull(),
    videoUrl: text('video_url'),
    posterFileId: uuid('poster_file_id').references(() => storedFiles.id, restrict),
    posterChecksum: text('poster_checksum'),
    authorizationKind: text('authorization_kind').notNull(),
    authorizationRef: uuid('authorization_ref').notNull(),
    /** `{ ranAt, patterns, passed }`。 */
    piiCheck: jsonb('pii_check').notNull(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, restrict),
    createdRealAt: timestamp('created_real_at', tz).notNull(),
  },
  (t) => [
    unique('showcase_versions_no_unique').on(t.entryId, t.versionNo),
    check('showcase_versions_version_no_check', sql`${t.versionNo} >= 1`),
    check('showcase_versions_authorization_kind_check', sql`${t.authorizationKind} in ('signoff','external')`),
    check('showcase_versions_poster_check', sql`(${t.posterFileId} is null) = (${t.posterChecksum} is null)`),
    check('showcase_versions_video_url_check', sql`${t.videoUrl} is null or ${t.videoUrl} ~ ${VIDEO_URL}`),
    check('showcase_versions_pii_check', sql`jsonb_typeof(${t.piiCheck}) = 'object'`),
  ],
)

/** 可變草稿（一個條目一份）。 */
export const showcaseDrafts = pgTable(
  'showcase_drafts',
  {
    entryId: uuid('entry_id')
      .primaryKey()
      .references(() => showcaseEntries.id, restrict),
    title: text('title').notNull().default(''),
    summary: text('summary').notNull().default(''),
    /** sha256(正規化後的摘要)，儲存時由伺服器算。 */
    summaryChecksum: text('summary_checksum').notNull(),
    videoUrl: text('video_url'),
    posterFileId: uuid('poster_file_id').references(() => storedFiles.id, restrict),
    posterChecksum: text('poster_checksum'),
    /** 可空：草稿不需要授權就能儲存（發布前才必填，S12）。 */
    authorizationKind: text('authorization_kind'),
    authorizationRef: uuid('authorization_ref'),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, restrict),
  },
  (t) => [
    check('showcase_drafts_title_check', sql`length(${t.title}) <= ${sql.raw(String(SHOWCASE_LIMITS.title))}`),
    check('showcase_drafts_summary_check', sql`length(${t.summary}) <= ${sql.raw(String(SHOWCASE_LIMITS.summary))}`),
    check('showcase_drafts_summary_checksum_check', sql`${t.summaryChecksum} ~ '^[0-9a-f]{64}$'`),
    check(
      'showcase_drafts_video_url_check',
      sql`${t.videoUrl} is null or (length(${t.videoUrl}) <= ${sql.raw(String(SHOWCASE_LIMITS.videoUrl))} and ${t.videoUrl} ~ ${VIDEO_URL})`,
    ),
    check('showcase_drafts_poster_check', sql`(${t.posterFileId} is null) = (${t.posterChecksum} is null)`),
    check(
      'showcase_drafts_authorization_check',
      sql`(${t.authorizationKind} is null) = (${t.authorizationRef} is null)
          and (${t.authorizationKind} is null or ${t.authorizationKind} in ('signoff','external'))`,
    ),
    check('showcase_drafts_revision_check', sql`${t.revision} >= 1`),
  ],
)
