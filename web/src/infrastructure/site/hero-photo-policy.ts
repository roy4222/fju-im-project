import 'server-only'
import type { Pool } from 'pg'
import type { DownloadPolicy } from '@/application/ops'

/**
 * 首頁大圖的下載政策（`DOWNLOAD_POLICIES.photo`；第三波 W3，設計方案 §3）。
 *
 * **只有目前 `home_settings.hero_file_id` 指到的那一張**對所有人（含訪客）公開——首頁 hero 要用。
 * 換圖後舊圖、剛上傳還沒存的圖、恢復預設後原本那張，一律回「無法存取」（與其他非公開檔案相同），
 * 管理員也不例外（剛選的圖在設定頁用瀏覽器本地預覽，不經下載）。每次下載都重查。
 */
export function createHeroPhotoPolicy(reader: () => Pick<Pool, 'query'>): DownloadPolicy {
  return async (_actor, file) => {
    const current = await reader().query('select 1 from home_settings where id = 1 and hero_file_id = $1', [file.id])
    return (current.rowCount ?? 0) > 0
  }
}
