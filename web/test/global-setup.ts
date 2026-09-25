/**
 * 整合測試的 globalSetup：整套只跑一次，在任何測試檔開始之前。
 *
 * 1. **先把 runtime 角色建好。** 角色是整個 PostgreSQL cluster 共用的，不屬於哪個 schema。
 *    migration 0001 用「`IF NOT EXISTS` 再 `CREATE ROLE`」建 `fju_app`／`fju_backup`，
 *    這在單一 migrator 下沒問題，但整合測試是好幾個測試檔同時在各自的 schema 套 migration：
 *    乾淨的庫上兩邊都看到「還沒有」、都去建，後到的撞 `pg_authid_rolname_index`（23505）。
 *    這裡先建好（並先給 `pg_read_all_data`），之後每個 schema 套 0001 時那兩段都變成 no-op。
 *    已套用過的 migration 不能改內容，所以修在 harness。
 *
 * 2. **角色密碼只在這裡設一次，而且能登入就不動。** 以前每個測試檔都 `ALTER ROLE ... PASSWORD`，
 *    本機若同一個資料庫上還跑著 app／worker（用 `.env` 的 `DATABASE_URL` 連 `fju_app`），
 *    密碼被改掉後它們新開的連線就登入失敗。現在先用測試密碼試連，連得上就不改；
 *    本機要讓兩邊共用，就把 `TEST_FJU_APP_PASSWORD` 設成 `.env` 裡 `fju_app` 的密碼。
 *    CI 的 integration 與 e2e-smoke 各自有一個 PostgreSQL service，互不影響。
 */
import { Client } from 'pg'
import { assertLocalTestDatabaseUrl, TEST_DATABASE_URL, runtimeRolePassword, type RuntimeRole } from './runtime-roles'

/** 跟其他同時啟動的整合測試（例如另一個終端機也在跑）錯開；值只要固定就好。 */
const SETUP_LOCK_KEY = 0x66_6a_75_01

async function canLogin(role: RuntimeRole, password: string): Promise<boolean> {
  const url = new URL(TEST_DATABASE_URL)
  url.username = role
  url.password = password
  const probe = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 3_000 })
  try {
    await probe.connect()
    return true
  } catch {
    return false
  } finally {
    await probe.end().catch(() => undefined)
  }
}

export default async function setup(): Promise<void> {
  // 3. 只准連本機：下面會建角色、改密碼，不能打到別的環境的資料庫。
  assertLocalTestDatabaseUrl(TEST_DATABASE_URL)
  const owner = new Client({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 3_000 })
  try {
    await owner.connect()
  } catch (error) {
    throw new Error(
      `連不到測試資料庫 ${TEST_DATABASE_URL.replace(/:[^:@]*@/, ':***@')}。` +
        '先在 repo 根跑 `docker compose up -d postgres`。原因：' +
        (error instanceof Error ? error.message : String(error)),
    )
  }

  try {
    await owner.query('select pg_advisory_lock($1)', [SETUP_LOCK_KEY])
    // 與 migration 0001 開頭同一段；先在這裡跑一次，之後各 schema 再跑就只是檢查。
    await owner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fju_app') THEN
          CREATE ROLE fju_app LOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fju_backup') THEN
          CREATE ROLE fju_backup LOGIN;
        END IF;
      END $$`)
    // 0001 也有這句；已經是成員時 PostgreSQL 只給 NOTICE，不再寫 catalog，並行就不會互撞。
    await owner.query('GRANT pg_read_all_data TO fju_backup')

    for (const role of ['fju_app', 'fju_backup'] as const) {
      const password = runtimeRolePassword(role)
      if (await canLogin(role, password)) continue
      await owner.query(`ALTER ROLE ${role} PASSWORD '${password.replaceAll("'", "''")}'`)
    }
  } finally {
    await owner.query('select pg_advisory_unlock($1)', [SETUP_LOCK_KEY]).catch(() => undefined)
    await owner.end()
  }
}
