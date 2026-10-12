/**
 * 測試地圖頁連出去的兩種網址：測試站的管理後台頁、自動測試檔在 GitHub 上的位置。
 */
export const TEST_SITE_ORIGIN = 'https://test.fju.roy422.dev'
export const REPO_BLOB_BASE = 'https://github.com/roy4222/fju-im-project/blob/main'

/** 管理後台頁（`/dashboard/...`）在測試站的完整網址。 */
export const testSiteUrl = (page: string) => `${TEST_SITE_ORIGIN}${page.startsWith('/') ? page : `/${page}`}`

/** repo 相對路徑（例如 `web/e2e/public-pages.spec.ts`）在 GitHub 的網址。 */
export const repoFileUrl = (file: string) => `${REPO_BLOB_BASE}/${file.replace(/^\/+/, '')}`

/** summary.json 的截圖路徑（`<item>/screenshots/<檔名>`）在本站的網址。 */
export const shotUrl = (runId: string, shot: string) =>
  `/shots/${encodeURIComponent(runId)}/${shot.split('/').map(encodeURIComponent).join('/')}`
