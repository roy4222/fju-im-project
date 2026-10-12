import 'server-only'
import { sql } from 'drizzle-orm'
import { check, integer, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from '@/infrastructure/db/schema/auth'
import { storedFiles } from '@/infrastructure/db/schema/files'

/**
 * 首頁設定（0012，第三波 W0 建表；W3 才寫）：首頁大圖＋兩行標語，系辦存了就生效（不分草稿與發布）。
 *
 * 固定只有一列（`id smallint CHECK (id = 1)`，同 `worker_heartbeat`）；還沒存過就沒有列，前台用程式內預設。
 * 四個內容欄 NULL＝用預設（「恢復預設」就是把它們清成 NULL，不刪列）。
 * 大圖沿用 `stored_files.purpose = 'photo'`，不寫 `file_references`；下載授權看這裡的 `hero_file_id`。
 */

const tz = { withTimezone: true } as const
const restrict = { onDelete: 'restrict', onUpdate: 'restrict' } as const

export const homeSettings = pgTable(
  'home_settings',
  {
    id: smallint('id').primaryKey().default(1),
    heroFileId: uuid('hero_file_id').references(() => storedFiles.id, restrict),
    heroAlt: text('hero_alt'),
    taglineLine1: text('tagline_line1'),
    taglineLine2: text('tagline_line2'),
    revision: integer('revision').notNull().default(1),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    updatedByUserId: uuid('updated_by_user_id')
      .notNull()
      .references(() => users.id, restrict),
  },
  (t) => [
    check('home_settings_single_row_check', sql`${t.id} = 1`),
    check('home_settings_hero_alt_check', sql`${t.heroAlt} is null or char_length(${t.heroAlt}) between 1 and 120`),
    check(
      'home_settings_tagline_line1_check',
      sql`${t.taglineLine1} is null or char_length(${t.taglineLine1}) between 1 and 40`,
    ),
    check(
      'home_settings_tagline_line2_check',
      sql`${t.taglineLine2} is null or char_length(${t.taglineLine2}) between 1 and 120`,
    ),
    check('home_settings_revision_check', sql`${t.revision} >= 1`),
  ],
)
