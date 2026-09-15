import 'server-only'
import { readHealth, unavailableHealth } from '@/infrastructure/health/health-reader'
import type { HealthSnapshot } from '@/shared/health'

/**
 * `/api/health` 的組裝根。
 *
 * 資料庫連不上是**預期中的**健康狀態之一，所以在這裡收斂成 `ok:false` 的快照，
 * 不把例外往上丟——例外訊息會帶連線字串，那是不能出現在回應裡的東西。
 * 真正的原因寫進伺服器 log。
 */
export async function getHealthSnapshot(): Promise<HealthSnapshot> {
  try {
    return await readHealth()
  } catch (error) {
    console.error('[health] 讀不到資料庫狀態', error)
    return unavailableHealth()
  }
}
