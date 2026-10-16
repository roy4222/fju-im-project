/**
 * 事件對到哪個容器的 log（DV 設計方案 §6.2）：錯誤紀錄每筆的「Dozzle」連結用 `<logs 根網址>/show?name=<容器名>`。
 *
 * 容器名來源（沒有在 VM 上 `docker ps` 核對過，改 compose 要一起改這裡）：
 * - 兩站：`docker-compose.vm.yml` 的 `container_name: fju-${FJU_SITE}-app`／`-postgres`（`ops/lib/site.sh` 疊在 `docker-compose.yml` 上）。
 * - 開發者後台：`docker-compose.status.yml` 是 project `fju-status`、沒設 `container_name`，
 *   預設名是 `<project>-<service>-1`（`ops/status-install.sh:248` 同一個規則）。
 *
 * Dozzle 的 `/show?name=` 是完全比對容器名（`assets/pages/show.vue`），所以要帶 `-1`。
 */
import { toolEntries } from '@/lib/data/hosts'
import type { Site } from '@/lib/data/types'

/** 站的網站容器（健康檢查失敗、部署失敗看這個）。 */
export const siteApp = (site: Site) => `fju-${site}-app`

/** 站的資料庫容器（`ops/backup.sh` 用它 `pg_dump`，備份失敗看這個）。 */
export const sitePostgres = (site: Site) => `fju-${site}-postgres`

export const COLLECTOR = 'fju-status-collector-1'
export const GATUS = 'fju-status-gatus-1'

/** collector 來源失敗看哪個容器：health 來源是讀 Gatus，其他都是收集器自己。 */
export const sourceContainer = (source: string) => (source === 'health' ? GATUS : COLLECTOR)

/** Dozzle 根網址（側欄「外部工具」同一個）。 */
export const dozzleRoot = (): string => toolEntries().find((t) => t.key === 'logs')!.url

/** 有容器名就深連結到那個容器，沒有就開 Dozzle 首頁。 */
export function dozzleUrl(container: string | null): string {
  const root = dozzleRoot()
  return container ? `${root}/show?name=${encodeURIComponent(container)}` : root
}
