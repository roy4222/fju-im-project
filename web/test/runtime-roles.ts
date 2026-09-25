/**
 * 整合測試連線設定（不 import schema，globalSetup 也能直接用）。
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL_OWNER ??
  'postgres://fju_owner:fju_local_dev@127.0.0.1:55432/fju'

export type RuntimeRole = 'fju_app' | 'fju_backup'

/**
 * 測試用的 runtime 角色密碼：`TEST_FJU_APP_PASSWORD`／`TEST_FJU_BACKUP_PASSWORD`，沒設就用本機預設。
 * 密碼由 `test/global-setup.ts` 在整套開始前設一次（登入得了就不動）。
 */
export function runtimeRolePassword(role: RuntimeRole): string {
  return process.env[`TEST_${role.toUpperCase()}_PASSWORD`] ?? `${role}_local_test`
}
