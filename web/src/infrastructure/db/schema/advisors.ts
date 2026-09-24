import 'server-only'
import { sql } from 'drizzle-orm'
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core'
import { users } from '@/infrastructure/db/schema/auth'
import { groups } from '@/infrastructure/db/schema/groups'

/**
 * 模組 03 的後三張擁有表：主指導指派、產學合作案、合作案連結（模組實作設計 03 附錄 A；第八支 migration，票 19）。
 *
 * 三張一起在 0007 建：票 20（合作案畫面、連結、名單匯出）在開發計畫裡標「改資料庫結構：否」，
 * 資料庫線也只有這一支 migration 輪得到它，所以合作案兩張表要在這裡一次建好，票 20 只寫用例與畫面。
 * 票 19 本身只用 `advisor_assignments`。
 *
 * 和附錄 A 不同的地方（照 0004 `group_memberships.removal_reason` 的做法）：
 * - `advisor_assignments` 多 `ended_real_at`、`ended_by_user_id`、`end_reason`：解除與重派的時間、操作者與理由
 *   記在被結束的那一列，不只在稽核裡（附錄 A 只有指派理由 `reason`）；另加 `previous_assignment_id`：
 *   重派時新的一列指向它接手的那一列，歷史上分得出「重派」和「解除後再指派」。
 * - `opportunity_links` 同樣多 `ended_real_at` 與 `previous_link_id`（換案前後關係，產品 6.3）；
 *   「解除或換案理由」附錄 A 叫 `reason`，這裡叫 `end_reason`，和上面同名同義。
 *
 * 兩條「同一時間只能有一個」由資料庫守：
 * - 一組同時只有一位有效主指導：`advisor_assignments` 部分唯一 `(group_id) WHERE valid_to IS NULL`
 *   （兩位老師同時認領，後到的撞到這條 → `ALREADY_CLAIMED`）。
 * - 一組同時最多連結一個合作案：`opportunity_links` 部分唯一 `(group_id) WHERE valid_to IS NULL`。
 */

const tz = { withTimezone: true } as const

/**
 * 主指導的有效區間列（附錄 A `advisor_assignments`）。認領、管理員逐組指派、CSV 批次指派都是插一列；
 * 重派＝結束舊列＋插新列（同一交易），解除＝只結束舊列。`fju_app` 只能改結束欄。
 * `valid_from`／`valid_to` 是業務時間（給「截止那一刻誰是主指導」的快照用）。
 */
export const advisorAssignments = pgTable(
  'advisor_assignments',
  {
    id: uuid('id').primaryKey(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    teacherUserId: uuid('teacher_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    /** `claim` 老師自己認領產學組；`admin` 管理員逐組指派；`csv` 管理員批次指派。 */
    source: text('source').notNull(),
    validFrom: timestamp('valid_from', tz).notNull(),
    validTo: timestamp('valid_to', tz),
    /** 誰建的這一列：認領是老師本人，其他是管理員。 */
    assignedByUserId: uuid('assigned_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    /** 指派理由：管理員指派（逐組、批次）必填；認領不需要。 */
    reason: text('reason'),
    /** 重派時：這一列接手的原主指導那一列（同一交易結束它）。首次指派、解除後再指派是 null。 */
    previousAssignmentId: uuid('previous_assignment_id').references((): AnyPgColumn => advisorAssignments.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    /** 結束（解除或被重派）的真實時間。 */
    endedRealAt: timestamp('ended_real_at', tz),
    endedByUserId: uuid('ended_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    /** 解除或重派的理由（結束這一列時填）。 */
    endReason: text('end_reason'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('advisor_assignments_one_active')
      .on(t.groupId)
      .where(sql`${t.validTo} is null`),
    index('advisor_assignments_group_idx').on(t.groupId),
    index('advisor_assignments_teacher_active_idx')
      .on(t.teacherUserId)
      .where(sql`${t.validTo} is null`),
    check('advisor_assignments_source_check', sql`${t.source} in ('claim','admin','csv')`),
    check('advisor_assignments_valid_range_check', sql`${t.validTo} is null or ${t.validTo} >= ${t.validFrom}`),
    check(
      'advisor_assignments_claim_self_check',
      sql`${t.source} <> 'claim' or ${t.assignedByUserId} = ${t.teacherUserId}`,
    ),
    check(
      'advisor_assignments_admin_reason_check',
      sql`${t.source} = 'claim' or length(btrim(coalesce(${t.reason}, ''))) > 0`,
    ),
    check(
      'advisor_assignments_ended_check',
      sql`(${t.validTo} is null) = (${t.endedRealAt} is null)
          and (${t.validTo} is null or (${t.endedByUserId} is not null and length(btrim(coalesce(${t.endReason}, ''))) > 0))`,
    ),
  ],
)

/**
 * 產學合作案頭列（附錄 A `industry_opportunities`；產品 6.1、6.2）。畫面、發布與下架在票 20。
 * 地址、聯絡人、電話、Email 只有案主與管理員看得到（由查詢的欄位白名單守，不靠這張表）。
 */
export const industryOpportunities = pgTable(
  'industry_opportunities',
  {
    id: uuid('id').primaryKey(),
    ownerTeacherUserId: uuid('owner_teacher_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    companyName: text('company_name').notNull(),
    department: text('department').notNull(),
    content: text('content').notNull(),
    requirements: text('requirements').notNull(),
    notes: text('notes'),
    /** 備註給誰看：`signed_in` 登入者、`internal` 只有案主與管理員。 */
    notesVisibility: text('notes_visibility').notNull().default('internal'),
    address: text('address'),
    contactName: text('contact_name'),
    contactPhone: text('contact_phone'),
    contactEmail: text('contact_email'),
    status: text('status').notNull().default('draft'),
    /** 最近一次發布、下架的業務時間（重新發布會更新）。 */
    publishedBusinessAt: timestamp('published_business_at', tz),
    withdrawnBusinessAt: timestamp('withdrawn_business_at', tz),
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
    index('industry_opportunities_owner_idx').on(t.ownerTeacherUserId),
    index('industry_opportunities_status_idx').on(t.status),
    check('industry_opportunities_status_check', sql`${t.status} in ('draft','published','withdrawn')`),
    check('industry_opportunities_notes_visibility_check', sql`${t.notesVisibility} in ('signed_in','internal')`),
    check(
      'industry_opportunities_published_at_check',
      sql`${t.status} <> 'published' or ${t.publishedBusinessAt} is not null`,
    ),
    check(
      'industry_opportunities_withdrawn_at_check',
      sql`${t.status} <> 'withdrawn' or ${t.withdrawnBusinessAt} is not null`,
    ),
    check('industry_opportunities_revision_check', sql`${t.revision} >= 1`),
    check('industry_opportunities_created_by_kind_check', sql`${t.createdByKind} in ('user','system','worker')`),
    check(
      'industry_opportunities_created_by_actor_check',
      sql`(${t.createdByKind} = 'user') = (${t.createdByUserId} is not null)`,
    ),
  ],
)

/**
 * 組別與合作案的連結（附錄 A `opportunity_links`；產品 6.3，Q-GRP03：一案多組、一組最多一案）。
 * 換案＝結束舊列＋插新列；解除＝結束舊列並填理由。`fju_app` 只能改結束欄。
 */
export const opportunityLinks = pgTable(
  'opportunity_links',
  {
    id: uuid('id').primaryKey(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => industryOpportunities.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    validFrom: timestamp('valid_from', tz).notNull(),
    validTo: timestamp('valid_to', tz),
    /** 組長或管理員。 */
    linkedByUserId: uuid('linked_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    /** 換案時：這一列接手的前一個連結（同一交易結束它）。 */
    previousLinkId: uuid('previous_link_id').references((): AnyPgColumn => opportunityLinks.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    endedRealAt: timestamp('ended_real_at', tz),
    endedByUserId: uuid('ended_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    /** 解除或換案理由（附錄 A 的 `reason`）。 */
    endReason: text('end_reason'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('opportunity_links_one_active')
      .on(t.groupId)
      .where(sql`${t.validTo} is null`),
    index('opportunity_links_group_idx').on(t.groupId),
    index('opportunity_links_opportunity_idx').on(t.opportunityId),
    check('opportunity_links_valid_range_check', sql`${t.validTo} is null or ${t.validTo} >= ${t.validFrom}`),
    check(
      'opportunity_links_ended_check',
      sql`(${t.validTo} is null) = (${t.endedRealAt} is null)
          and (${t.validTo} is null or (${t.endedByUserId} is not null and length(btrim(coalesce(${t.endReason}, ''))) > 0))`,
    ),
  ],
)
