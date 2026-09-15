import 'server-only'
import { relations, sql } from 'drizzle-orm'
import { boolean, check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * 帳號四表（S00-02）。
 *
 * 欄位「名稱」以 Better Auth 產生器的輸出為準，逐欄對照 `auth.generated.ts`
 * （`auth-schema.test.ts` 會斷言兩邊的表名與欄名完全一致）。
 * 欄位「型別」依契約 01 §1 調整，產生器給不出這些：
 *   - 主鍵與 user FK 一律 `uuid`（應用產生 uuidv7），不是 text。
 *   - 時間欄一律 `timestamptz`（UTC）。
 *   - FK 預設 `ON DELETE RESTRICT`；使用者列永不硬刪，改去識別化，所以不 CASCADE。
 * 契約 01 §4.1 的 CHECK 白名單（`users.status`、`sessions.login_method`）與索引 `users(status)`
 * 也在這裡宣告，跟著第一支 migration 一起建（S00-04）。
 */

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull().unique(),
    emailVerified: boolean('email_verified').default(false).notNull(),
    image: text('image'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    // admin plugin 的套件欄：只由 Better Auth 的 banUser／unbanUser 寫（契約 01 §4.1）。
    role: text('role'),
    banned: boolean('banned').default(false),
    banReason: text('ban_reason'),
    banExpires: timestamp('ban_expires', { withTimezone: true }),
    // 業務擴充三欄（契約 01 §4.1）。
    status: text('status').default('pending').notNull(),
    mustChangePassword: boolean('must_change_password').default(false).notNull(),
    deidentifiedAt: timestamp('deidentified_at', { withTimezone: true }),
  },
  (t) => [
    check('users_status_check', sql`${t.status} in ('pending','active','disabled')`),
    index('users_status_idx').on(t.status),
  ],
)

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    impersonatedBy: text('impersonated_by'),
    // 業務擴充一欄：這次登入用的方式（契約 01 §4.1）。
    loginMethod: text('login_method').notNull(),
  },
  (table) => [
    check('sessions_login_method_check', sql`${table.loginMethod} in ('google','password')`),
    index('sessions_userId_idx').on(table.userId),
  ],
)

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('accounts_userId_idx').on(table.userId)],
)

export const verifications = pgTable(
  'verifications',
  {
    id: uuid('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('verifications_identifier_idx').on(table.identifier)],
)

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  accounts: many(accounts),
}))

export const sessionsRelations = relations(sessions, ({ one }) => ({
  users: one(users, { fields: [sessions.userId], references: [users.id] }),
}))

export const accountsRelations = relations(accounts, ({ one }) => ({
  users: one(users, { fields: [accounts.userId], references: [users.id] }),
}))
