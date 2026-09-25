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
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import { users } from '@/infrastructure/db/schema/auth'
import { cohorts } from '@/infrastructure/db/schema/base'
import { storedFiles } from '@/infrastructure/db/schema/files'
import { groups } from '@/infrastructure/db/schema/groups'
import { cohortStages } from '@/infrastructure/db/schema/timeline'

/**
 * 模組 04 專題事務的六張表＋模組 05 的收件名單表（模組實作設計 04／05 附錄 A；第五支 migration，票 15）。
 *
 * 通用規則同契約 01 §1：uuid 主鍵、列舉用 CHECK、timestamptz、FK RESTRICT、可變頭列帶 revision。
 *
 * 草稿與已發布的分工（票 15 定，附錄 A 沒寫死）：
 * - `managed_items` 是**工作副本**：標題、摘要、正文、封面、分類、欄位草稿（`draft_schema`）都在頭列，
 *   草稿期間隨時存；發布設定（位置、對象、收件單位、階段、開放、截止）也在頭列，而且就是**目前生效**的值。
 * - 按「發布」或「發布更新」時，才把內容切一份不可變的 `item_versions`、欄位切一份 `form_schema_versions`，
 *   頭列的 `current_*_version_id` 指過去。已發布的項目不留「未發布的修改」：改了就是整筆交易套用（發布更新）。
 * - 所以自動存檔不會往不可變表塞一堆列；不可變表裡的每一版都是「曾經給人看過的樣子」。
 */

const tz = { withTimezone: true } as const
const restrict = { onDelete: 'restrict', onUpdate: 'restrict' } as const

/**
 * 專題事務頭列（附錄 A `managed_items`）。
 *
 * 一個項目一個 ID：快速建立與完整編輯器操作同一列（產品模組 04「單一入口」）。
 * 收件（`receiver_unit <> 'none'`）的限制有兩層：對象只能是本屆學生或指定組別（DB 一律守），
 * 階段與截止必填（DB 只在不是草稿時守——草稿可以先存一半）。
 */
export const managedItems = pgTable(
  'managed_items',
  {
    id: uuid('id').primaryKey(),
    /** 綁定的屆別：「本屆」在每個項目上是明確的屆別，不隨目前屆別切換而改變（產品模組 04 §4.3）。 */
    cohortId: uuid('cohort_id').notNull().references(() => cohorts.id, restrict),
    /** 主要發布位置（單選）。CHECK 保留附錄 A 全部七種；票 15 的畫面只開公告、資源、文件繳交。 */
    placement: text('placement').notNull(),
    audienceKind: text('audience_kind').notNull(),
    /** 收件單位：none（公告、資源）、individual（每人一份）、group（每組一份）。有回答後鎖定（用例守）。 */
    receiverUnit: text('receiver_unit').notNull().default('none'),
    /** 所屬階段：收件必設；延長截止到下一階段也不自動改（產品模組 04「發布檢查與時間邊界」）。 */
    stageId: uuid('stage_id').references(() => cohortStages.id, restrict),
    status: text('status').notNull().default('draft'),
    /** 設定的開放時間；NULL＝發布即開放。 */
    opensAt: timestamp('opens_at', tz),
    /** 實際開放時間（業務時間）：第一次發布時寫一次，之後修改或重新發布都不重設。 */
    actualOpenedAt: timestamp('actual_opened_at', tz),
    /** 截止**分鐘的起點**：`received < due_at + 1 分鐘` 都算準時（母 spec §4.11）。 */
    dueAt: timestamp('due_at', tz),
    /** 期限版本：截止每改一次 +1，到期工作用它換版（契約 01 §4.7）。 */
    deadlineVersion: integer('deadline_version').notNull().default(1),
    currentContentVersionId: uuid('current_content_version_id').references(
      (): AnyPgColumn => itemVersions.id,
      restrict,
    ),
    currentSchemaVersionId: uuid('current_schema_version_id').references(
      (): AnyPgColumn => formSchemaVersions.id,
      restrict,
    ),
    title: text('title').notNull(),
    summary: text('summary').notNull().default(''),
    /** 正文：伺服器以白名單清理過的受限 HTML（契約 03 §5）。 */
    bodyHtml: text('body_html').notNull().default(''),
    coverFileId: uuid('cover_file_id').references(() => storedFiles.id, restrict),
    category: text('category'),
    /**
     * 競賽資訊（公告分類「競賽資訊」）的報名截止日與活動日（0011，票 39；臺灣日曆日）。
     * 前台依這兩天與今天推「報名中／決賽／已結束」，狀態本身不存（原型 `competitionStatus`）。只有公告能填。
     */
    registrationDeadline: date('registration_deadline', { mode: 'string' }),
    eventDate: date('event_date', { mode: 'string' }),
    /** 榮譽榜的得獎日期（0011，票 39；臺灣日曆日）：年份篩選與排序用它，沒填才退回發布日。只有榮譽能填。 */
    awardedOn: date('awarded_on', { mode: 'string' }),
    /** 收件欄位的工作副本 `{ fields: [...] }`；發布時切成 `form_schema_versions`。 */
    draftSchema: jsonb('draft_schema').notNull().default(sql`'{"fields":[]}'::jsonb`),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    createdByKind: text('created_by_kind').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, restrict),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, restrict),
  },
  (t) => [
    check(
      'managed_items_placement_check',
      sql`${t.placement} in ('news','resource','submission','requirement','rules','showcase','honor')`,
    ),
    check(
      'managed_items_audience_kind_check',
      sql`${t.audienceKind} in ('public','signed_in','cohort_students','teachers','groups')`,
    ),
    check('managed_items_receiver_unit_check', sql`${t.receiverUnit} in ('none','individual','group')`),
    check('managed_items_status_check', sql`${t.status} in ('draft','published','archived')`),
    // 收件只開給學生：本屆學生或指定組別（產品模組 04「單一入口與收件單位」；不開公開、所有登入者、全部老師）。
    check(
      'managed_items_receiver_audience_check',
      sql`${t.receiverUnit} = 'none' or ${t.audienceKind} in ('cohort_students','groups')`,
    ),
    // 只有收件類位置能收件；公告、資源一定是 none。
    check(
      'managed_items_receiver_placement_check',
      sql`${t.receiverUnit} = 'none' or ${t.placement} in ('submission','requirement')`,
    ),
    // 收件一離開草稿就一定有階段與截止。
    check(
      'managed_items_receiver_schedule_check',
      sql`${t.status} = 'draft' or ${t.receiverUnit} = 'none' or (${t.stageId} is not null and ${t.dueAt} is not null)`,
    ),
    // 截止不得早於開放（設定的開放；沒設就是實際開放）。
    check('managed_items_due_after_open_check', sql`${t.dueAt} >= coalesce(${t.opensAt}, ${t.actualOpenedAt})`),
    // 發布過就一定有實際開放時間與兩個目前版本。
    check(
      'managed_items_published_check',
      sql`${t.status} = 'draft' or (${t.actualOpenedAt} is not null
          and ${t.currentContentVersionId} is not null and ${t.currentSchemaVersionId} is not null)`,
    ),
    check('managed_items_deadline_version_check', sql`${t.deadlineVersion} >= 1`),
    check(
      'managed_items_competition_dates_check',
      sql`(${t.registrationDeadline} is null and ${t.eventDate} is null) or ${t.placement} = 'news'`,
    ),
    check(
      'managed_items_event_after_deadline_check',
      sql`${t.eventDate} is null or ${t.registrationDeadline} is null or ${t.eventDate} >= ${t.registrationDeadline}`,
    ),
    check('managed_items_awarded_on_check', sql`${t.awardedOn} is null or ${t.placement} = 'honor'`),
    check(
      'managed_items_draft_schema_check',
      sql`coalesce(jsonb_typeof(${t.draftSchema} -> 'fields'), 'missing') = 'array'`,
    ),
    check('managed_items_created_by_kind_check', sql`${t.createdByKind} in ('user','system','worker')`),
    check(
      'managed_items_created_by_actor_check',
      sql`(${t.createdByKind} = 'user') = (${t.createdByUserId} is not null)`,
    ),
    index('managed_items_cohort_status_placement_idx').on(t.cohortId, t.status, t.placement),
    index('managed_items_cohort_due_idx').on(t.cohortId, t.dueAt),
  ],
)

/** 指定組別的受眾集合（附錄 A `item_audience_groups`）。只在 `audience_kind='groups'` 時有列。 */
export const itemAudienceGroups = pgTable(
  'item_audience_groups',
  {
    itemId: uuid('item_id').notNull().references(() => managedItems.id, restrict),
    groupId: uuid('group_id').notNull().references(() => groups.id, restrict),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: 'item_audience_groups_pk', columns: [t.itemId, t.groupId] })],
)

/** 內容版本（附錄 A `item_versions`，不可變）：每次發布或發布更新切一版。 */
export const itemVersions = pgTable(
  'item_versions',
  {
    id: uuid('id').primaryKey(),
    itemId: uuid('item_id').notNull().references(() => managedItems.id, restrict),
    versionNo: integer('version_no').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    bodyHtml: text('body_html').notNull(),
    coverFileId: uuid('cover_file_id').references(() => storedFiles.id, restrict),
    category: text('category'),
    createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id, restrict),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    unique('item_versions_item_version_unique').on(t.itemId, t.versionNo),
    check('item_versions_version_no_check', sql`${t.versionNo} >= 1`),
  ],
)

/** 收件欄位結構版本（附錄 A `form_schema_versions`，不可變）。公告也有 v1（空欄位），發布後兩個指標都一定有值。 */
export const formSchemaVersions = pgTable(
  'form_schema_versions',
  {
    id: uuid('id').primaryKey(),
    itemId: uuid('item_id').notNull().references(() => managedItems.id, restrict),
    versionNo: integer('version_no').notNull(),
    schema: jsonb('schema').notNull(),
    createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id, restrict),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    unique('form_schema_versions_item_version_unique').on(t.itemId, t.versionNo),
    check('form_schema_versions_version_no_check', sql`${t.versionNo} >= 1`),
    check('form_schema_versions_schema_check', sql`coalesce(jsonb_typeof(${t.schema} -> 'fields'), 'missing') = 'array'`),
  ],
)

/**
 * 附件集合（附錄 A `item_attachments`）。移除＝刪這一列並釋放 `file_references`；
 * 再附回來插新列與新的有效引用（契約 01 §11）。下載授權看項目的對象（`DOWNLOAD_POLICIES.attachment`）。
 */
export const itemAttachments = pgTable(
  'item_attachments',
  {
    itemId: uuid('item_id').notNull().references(() => managedItems.id, restrict),
    fileId: uuid('file_id').notNull().references(() => storedFiles.id, restrict),
    sort: integer('sort').notNull(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: 'item_attachments_pk', columns: [t.itemId, t.fileId] })],
)

/**
 * 發布紀錄（附錄 A `item_publications`，不可變）：發布、發布更新的每一種變更各一列，記操作者與雙時間。
 * 撤回、下架、重新發布（票 16）也寫這張表，所以 CHECK 先放齊。
 */
export const itemPublications = pgTable(
  'item_publications',
  {
    id: uuid('id').primaryKey(),
    itemId: uuid('item_id').notNull().references(() => managedItems.id, restrict),
    action: text('action').notNull(),
    contentVersionId: uuid('content_version_id').references(() => itemVersions.id, restrict),
    schemaVersionId: uuid('schema_version_id').references(() => formSchemaVersions.id, restrict),
    /** 改期時記新的期限版本。 */
    deadlineVersion: integer('deadline_version'),
    /** 這次有沒有發通知（小幅修改由管理員選）。 */
    notify: boolean('notify').notNull(),
    actorUserId: uuid('actor_user_id').notNull().references(() => users.id, restrict),
    realAt: timestamp('real_at', tz).notNull(),
    businessAt: timestamp('business_at', tz).notNull(),
  },
  (t) => [
    check(
      'item_publications_action_check',
      sql`${t.action} in ('publish','withdraw','archive','republish','deadline_change','schema_change',
          'content_change','settings_change')`,
    ),
    index('item_publications_item_idx').on(t.itemId),
  ],
)

/**
 * 收件名單（模組 05 附錄 A `response_rosters`；表歸模組 05，由票 15 的 migration 建）。
 *
 * 一列＝「某人（或某組）在某段期間必須交這份收件」。目前名單＝`eligible_to_business_at IS NULL`，
 * 部分唯一保證同一個收件者同時只有一列有效。移出只寫結束時間與理由，不刪列（歷史保留）。
 * `receiver_id` 依 `receiver_kind` 指 users 或 groups，不設 FK（附錄 A：用例檢查）。
 */
export const responseRosters = pgTable(
  'response_rosters',
  {
    id: uuid('id').primaryKey(),
    itemId: uuid('item_id').notNull().references(() => managedItems.id, restrict),
    cohortId: uuid('cohort_id').notNull().references(() => cohorts.id, restrict),
    receiverKind: text('receiver_kind').notNull(),
    receiverId: uuid('receiver_id').notNull(),
    eligibleFromBusinessAt: timestamp('eligible_from_business_at', tz).notNull(),
    eligibleToBusinessAt: timestamp('eligible_to_business_at', tz),
    source: text('source').notNull(),
    exempt: boolean('exempt').notNull().default(false),
    exemptReason: text('exempt_reason'),
    removedReason: text('removed_reason'),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    createdByKind: text('created_by_kind').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, restrict),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, restrict),
  },
  (t) => [
    check('response_rosters_receiver_kind_check', sql`${t.receiverKind} in ('user','group')`),
    check('response_rosters_source_check', sql`${t.source} in ('auto','admin')`),
    // 免填一定有理由（產品模組 05「管理員可對個別人設免填，必填理由」）。
    check(
      'response_rosters_exempt_reason_check',
      sql`not ${t.exempt} or length(btrim(coalesce(${t.exemptReason}, ''))) > 0`,
    ),
    // 移出一定有結束時間與理由；還在名單上就兩個都沒有。
    check(
      'response_rosters_removed_check',
      sql`(${t.eligibleToBusinessAt} is null) = (${t.removedReason} is null)`,
    ),
    check(
      'response_rosters_range_check',
      sql`${t.eligibleToBusinessAt} is null or ${t.eligibleToBusinessAt} >= ${t.eligibleFromBusinessAt}`,
    ),
    check('response_rosters_created_by_kind_check', sql`${t.createdByKind} in ('user','system','worker')`),
    check(
      'response_rosters_created_by_actor_check',
      sql`(${t.createdByKind} = 'user') = (${t.createdByUserId} is not null)`,
    ),
    uniqueIndex('response_rosters_one_current')
      .on(t.itemId, t.receiverKind, t.receiverId)
      .where(sql`${t.eligibleToBusinessAt} is null`),
    index('response_rosters_item_idx').on(t.itemId),
    index('response_rosters_receiver_idx').on(t.receiverKind, t.receiverId),
  ],
)
