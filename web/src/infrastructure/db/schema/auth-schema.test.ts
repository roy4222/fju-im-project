import { describe, expect, it } from 'vitest'
import { getTableColumns, getTableName } from 'drizzle-orm'
import { accounts, sessions, users, verifications } from '@/infrastructure/db/schema/auth'
import * as generated from '@/infrastructure/db/schema/auth.generated'

/**
 * S00-02 的快照測試。
 *
 * 兩件事要守住：
 * 1. 我們手上的 schema 與 Better Auth 產生器的輸出「表名與欄名」完全一致
 *    （型別刻意不同：契約 01 §1 要 uuid／timestamptz／RESTRICT，產生器給 text／timestamp／CASCADE）。
 *    產生器輸出在 `auth.generated.ts`，跑 `pnpm auth:generate` 重產。
 * 2. 契約 01 §4.1 點名的業務擴充欄與 admin plugin 套件欄確實存在，而且 SQL 欄名如契約所寫。
 */

const ours = { users, sessions, accounts, verifications }
const theirs = {
  users: generated.users,
  sessions: generated.sessions,
  accounts: generated.accounts,
  verifications: generated.verifications,
}

function sqlColumnNames(table: Parameters<typeof getTableColumns>[0]): string[] {
  return Object.values(getTableColumns(table))
    .map((column) => column.name)
    .sort()
}

describe('帳號四表與產生器輸出一致（表名、欄名）', () => {
  it.each(Object.keys(ours) as (keyof typeof ours)[])('%s 的表名一致', (key) => {
    expect(getTableName(ours[key])).toBe(getTableName(theirs[key]))
  })

  it.each(Object.keys(ours) as (keyof typeof ours)[])('%s 的欄名一致', (key) => {
    expect(sqlColumnNames(ours[key])).toEqual(sqlColumnNames(theirs[key]))
  })

  it('四張表就是 users、sessions、accounts、verifications', () => {
    expect(Object.values(ours).map(getTableName).sort()).toEqual([
      'accounts',
      'sessions',
      'users',
      'verifications',
    ])
  })
})

describe('契約 01 §4.1 的欄位確實存在', () => {
  it('users 的業務擴充三欄', () => {
    const names = sqlColumnNames(users)
    expect(names).toContain('status')
    expect(names).toContain('must_change_password')
    expect(names).toContain('deidentified_at')
  })

  it('users 的 admin plugin 套件欄就是 banned／ban_reason／ban_expires', () => {
    const names = sqlColumnNames(users)
    expect(names).toContain('banned')
    expect(names).toContain('ban_reason')
    expect(names).toContain('ban_expires')
  })

  it('sessions 有 login_method', () => {
    expect(sqlColumnNames(sessions)).toContain('login_method')
  })

  it('status 預設 pending、must_change_password 預設 false', () => {
    const columns = getTableColumns(users)
    expect(columns.status.default).toBe('pending')
    expect(columns.status.notNull).toBe(true)
    expect(columns.mustChangePassword.default).toBe(false)
    expect(columns.mustChangePassword.notNull).toBe(true)
  })
})

describe('契約 01 §1 的型別調整確實套上去了', () => {
  it('四張表的主鍵都是 uuid，不是產生器預設的 text', () => {
    for (const table of Object.values(ours)) {
      expect(getTableColumns(table).id.getSQLType()).toBe('uuid')
    }
  })

  it('user FK 是 uuid', () => {
    expect(getTableColumns(sessions).userId.getSQLType()).toBe('uuid')
    expect(getTableColumns(accounts).userId.getSQLType()).toBe('uuid')
  })

  it('時間欄都帶時區', () => {
    for (const table of Object.values(ours)) {
      for (const column of Object.values(getTableColumns(table))) {
        if (column.getSQLType().startsWith('timestamp')) {
          expect(column.getSQLType()).toContain('with time zone')
        }
      }
    }
  })

  it('產生器那份確實是 text 主鍵，證明差異是我們刻意改的', () => {
    expect(getTableColumns(theirs.users).id.getSQLType()).toBe('text')
  })
})
