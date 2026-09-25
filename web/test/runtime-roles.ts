/**
 * 整合測試連線設定（不 import schema，globalSetup 也能直接用）。
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL_OWNER ??
  'postgres://fju_owner:fju_local_dev@127.0.0.1:55432/fju'

/** 整合測試只准連本機（本機 Compose 與 CI 的 service 都是 127.0.0.1）。 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * 整合測試會建角色、改 runtime 角色密碼、每個測試檔建 schema：連線字串**不是本機**就拒絕，
 * 免得 shell 裡剛好 export 了正式站或測試站的 `DATABASE_URL_OWNER` 就對它動手。
 * 錯誤訊息裡的密碼遮掉。
 */
export function assertLocalTestDatabaseUrl(connectionString: string): void {
  let url: URL
  try {
    url = new URL(connectionString)
  } catch {
    throw new Error('整合測試的資料庫連線字串格式不對（TEST_DATABASE_URL／DATABASE_URL_OWNER）。')
  }
  const masked = connectionString.replace(/:[^:@/]*@/, ':***@')
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`整合測試只接受 postgres:// 連線字串，收到 ${masked}。`)
  }
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error(
      `整合測試只准連本機資料庫（localhost／127.0.0.1／::1），收到 ${masked}。` +
        '請把 TEST_DATABASE_URL 指到本機的測試庫（例如 `docker compose up -d postgres`），不要沿用別的環境的 DATABASE_URL_OWNER。',
    )
  }
}

export type RuntimeRole = 'fju_app' | 'fju_backup'

/**
 * 測試用的 runtime 角色密碼：`TEST_FJU_APP_PASSWORD`／`TEST_FJU_BACKUP_PASSWORD`，沒設就用本機預設。
 * 密碼由 `test/global-setup.ts` 在整套開始前設一次（登入得了就不動）。
 */
export function runtimeRolePassword(role: RuntimeRole): string {
  return process.env[`TEST_${role.toUpperCase()}_PASSWORD`] ?? `${role}_local_test`
}
