import 'server-only'
import { sql } from 'drizzle-orm'
import { check, index, integer, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { users } from '@/infrastructure/db/schema/auth'
import { cohorts } from '@/infrastructure/db/schema/base'

/**
 * 模組 03 分組的六張擁有表（模組實作設計 03 附錄 A；第四支 migration，票 13）。
 *
 * 通用規則同契約 01 §1：uuid 主鍵、列舉用 CHECK、timestamptz、FK RESTRICT、可變頭列帶 revision。
 * 2026-09-24 Roy 定案取消「例外組」，所以 `groups` 沒有附錄 A 的 `exception_basis`；
 * 每組人數改由管理員設定（`cohorts.group_size_min／max`），特殊情況由管理員直接調整組員（票 14）。
 *
 * 三條「同一時間只能有一個」的規則都由資料庫守，不靠程式先查再寫：
 * - 一人同時只在一個進行中提案：`proposal_occupancy.user_id` 是主鍵（占用表，契約 01 §1）。
 * - 一人同屆只在一個有效組：`group_memberships` 部分唯一 `(user_id, cohort_id) WHERE valid_to IS NULL`。
 * - 一組同時只有一位有效組長：`group_leaders` 部分唯一 `(group_id) WHERE valid_to IS NULL`。
 */

const tz = { withTimezone: true } as const

/** 組別（附錄 A `groups`）。代碼在屆別內遞增：G01、G02…（配號規則 spec 未寫，S03-06 暫定）。 */
export const groups = pgTable(
  'groups',
  {
    id: uuid('id').primaryKey(),
    cohortId: uuid('cohort_id')
      .notNull()
      .references(() => cohorts.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    code: text('code').notNull(),
    groupType: text('group_type').notNull(),
    status: text('status').notNull().default('active'),
    establishedRealAt: timestamp('established_real_at', tz).notNull(),
    establishedBusinessAt: timestamp('established_business_at', tz).notNull(),
    dissolvedRealAt: timestamp('dissolved_real_at', tz),
    dissolveReason: text('dissolve_reason'),
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
    unique('groups_cohort_code_unique').on(t.cohortId, t.code),
    check('groups_group_type_check', sql`${t.groupType} in ('general','industry')`),
    check('groups_status_check', sql`${t.status} in ('active','dissolved')`),
    // 解散一定留時間與理由；沒解散就兩個都不能有。
    check(
      'groups_dissolved_check',
      sql`(${t.status} = 'dissolved') = (${t.dissolvedRealAt} is not null)
          and (${t.status} <> 'dissolved' or ${t.dissolveReason} is not null)`,
    ),
    check('groups_created_by_kind_check', sql`${t.createdByKind} in ('user','system','worker')`),
    check(
      'groups_created_by_actor_check',
      sql`(${t.createdByKind} = 'user') = (${t.createdByUserId} is not null)`,
    ),
  ],
)

/**
 * 提案頭列（附錄 A `group_proposals`）。只有「進行中→成立」或「進行中→終止」兩條路（Q-GRP01）。
 *
 * 成員名單不在這張表：每人一列放在 `proposal_invitations`（含提案人自己，提案人也要按確認）。
 * `closed_*` 是成立或終止的那一刻與操作者（終止可能是本人、管理員或到期的背景工作）。
 */
export const groupProposals = pgTable(
  'group_proposals',
  {
    id: uuid('id').primaryKey(),
    cohortId: uuid('cohort_id')
      .notNull()
      .references(() => cohorts.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    proposerUserId: uuid('proposer_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    groupType: text('group_type').notNull(),
    /** min(發起＋預設天數, 成組截止)；畫面照這個顯示確切到期時間。 */
    expiresBusinessAt: timestamp('expires_business_at', tz).notNull(),
    state: text('state').notNull().default('open'),
    terminationKind: text('termination_kind'),
    /** 只有管理員作廢必填；學生看到的通知不帶這段。 */
    reason: text('reason'),
    establishedGroupId: uuid('established_group_id').references(() => groups.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    /** 到期工作的期限版本（契約 01 §4.7）。 */
    deadlineVersion: integer('deadline_version').notNull().default(1),
    revision: integer('revision').notNull().default(1),
    createdRealAt: timestamp('created_real_at', tz).notNull(),
    createdBusinessAt: timestamp('created_business_at', tz).notNull(),
    closedRealAt: timestamp('closed_real_at', tz),
    closedBusinessAt: timestamp('closed_business_at', tz),
    closedByKind: text('closed_by_kind'),
    closedByUserId: uuid('closed_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (t) => [
    check('group_proposals_group_type_check', sql`${t.groupType} in ('general','industry')`),
    check('group_proposals_state_check', sql`${t.state} in ('open','established','terminated')`),
    check(
      'group_proposals_termination_kind_check',
      sql`${t.terminationKind} is null or ${t.terminationKind} in
          ('declined','member_withdrew','proposer_withdrew','expired','admin_voided','conflict')`,
    ),
    // 標了終止就一定有終止原因；沒終止就不能有。
    check('group_proposals_terminated_kind_check', sql`(${t.state} = 'terminated') = (${t.terminationKind} is not null)`),
    // 管理員作廢必填理由（產品模組 03「提案終止」）。
    check(
      'group_proposals_admin_voided_reason_check',
      sql`${t.terminationKind} is distinct from 'admin_voided' or length(btrim(coalesce(${t.reason}, ''))) > 0`,
    ),
    check(
      'group_proposals_established_group_check',
      sql`(${t.state} = 'established') = (${t.establishedGroupId} is not null)`,
    ),
    check(
      'group_proposals_closed_check',
      sql`(${t.state} = 'open') = (${t.closedRealAt} is null)
          and (${t.closedRealAt} is null) = (${t.closedBusinessAt} is null)
          and (${t.closedRealAt} is null) = (${t.closedByKind} is null)`,
    ),
    check(
      'group_proposals_closed_by_kind_check',
      sql`${t.closedByKind} is null or ${t.closedByKind} in ('user','system','worker')`,
    ),
    check(
      'group_proposals_closed_by_actor_check',
      sql`${t.closedByKind} is null or (${t.closedByKind} = 'user') = (${t.closedByUserId} is not null)`,
    ),
    check('group_proposals_deadline_version_check', sql`${t.deadlineVersion} >= 1`),
    index('group_proposals_cohort_state_idx').on(t.cohortId, t.state),
    index('group_proposals_proposer_idx').on(t.proposerUserId),
  ],
)

/**
 * 每位成員一列（附錄 A `proposal_invitations`；提案人自己也有一列）。
 *
 * `fju_app` 只能改 `state` 與 `decided_real_at`。`decided_real_at` 是本人最後一次按確認／拒絕／撤回的時間；
 * 提案終止時其他人的列轉成 released，但**不覆寫** `decided_real_at`——所以「確認過、後來因終止被釋放」
 * 看得出來（released 且 decided_real_at 不是 NULL）。
 */
export const proposalInvitations = pgTable(
  'proposal_invitations',
  {
    id: uuid('id').primaryKey(),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => groupProposals.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    state: text('state').notNull().default('pending'),
    decidedRealAt: timestamp('decided_real_at', tz),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    unique('proposal_invitations_proposal_user_unique').on(t.proposalId, t.userId),
    check(
      'proposal_invitations_state_check',
      sql`${t.state} in ('pending','confirmed','declined','withdrawn','released')`,
    ),
    index('proposal_invitations_user_idx').on(t.userId),
  ],
)

/**
 * 占用表（附錄 A `proposal_occupancy`；契約 01 §1）：列存在＝這個人正被某個進行中提案占住。
 * 發起時 INSERT，成立或終止時 DELETE。主鍵就是 `user_id`，撞了就是 `INVITED_ELSEWHERE`。
 */
export const proposalOccupancy = pgTable(
  'proposal_occupancy',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => groupProposals.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [index('proposal_occupancy_proposal_idx').on(t.proposalId)],
)

/**
 * 組員的有效區間列（附錄 A `group_memberships`）。`valid_from`／`valid_to` 是業務時間
 * （給「截止那一刻誰是組員」這類快照用）；`fju_app` 只能改結束欄（`valid_to`、`removal_reason`、`updated_at`）。
 * `cohort_id` 冗餘存一份，才能做「一人同屆一個有效組」的部分唯一。
 */
export const groupMemberships = pgTable(
  'group_memberships',
  {
    id: uuid('id').primaryKey(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    cohortId: uuid('cohort_id')
      .notNull()
      .references(() => cohorts.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    validFrom: timestamp('valid_from', tz).notNull(),
    validTo: timestamp('valid_to', tz),
    addedByKind: text('added_by_kind').notNull(),
    addedByUserId: uuid('added_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    removalReason: text('removal_reason'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('group_memberships_one_active')
      .on(t.userId, t.cohortId)
      .where(sql`${t.validTo} is null`),
    check('group_memberships_valid_range_check', sql`${t.validTo} is null or ${t.validTo} >= ${t.validFrom}`),
    check('group_memberships_added_by_kind_check', sql`${t.addedByKind} in ('user','system','worker')`),
    check(
      'group_memberships_added_by_actor_check',
      sql`(${t.addedByKind} = 'user') = (${t.addedByUserId} is not null)`,
    ),
    index('group_memberships_group_idx').on(t.groupId),
  ],
)

/**
 * 組長的有效區間列（附錄 A `group_leaders`）。提案人預設成為組長；換組長（票 14）是結束舊列、插入新列。
 * `fju_app` 只能改 `valid_to`。「組長必須是有效成員」由用例檢查。
 */
export const groupLeaders = pgTable(
  'group_leaders',
  {
    id: uuid('id').primaryKey(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    validFrom: timestamp('valid_from', tz).notNull(),
    validTo: timestamp('valid_to', tz),
    changedByUserId: uuid('changed_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    reason: text('reason'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('group_leaders_one_active')
      .on(t.groupId)
      .where(sql`${t.validTo} is null`),
    check('group_leaders_valid_range_check', sql`${t.validTo} is null or ${t.validTo} >= ${t.validFrom}`),
  ],
)
