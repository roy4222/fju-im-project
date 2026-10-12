import 'server-only'
import type { HomeSettingsCommand, HomeSettingsQuery } from '@/application/site'
import { getBusinessClock } from '@/composition/cohorts'
import { getAuditWriter, getFileStorage, getOperationLedger } from '@/composition/ops'
import { PgHomeSettingsCommand, PgHomeSettingsQuery } from '@/infrastructure/site/pg-home-settings'

/** 首頁設定（第三波 W3）的實例組裝：存了就生效，首頁每次請求都讀。 */
let homeSettingsCommand: HomeSettingsCommand | undefined
let homeSettingsQuery: HomeSettingsQuery | undefined

export function getHomeSettingsCommand(): HomeSettingsCommand {
  homeSettingsCommand ??= new PgHomeSettingsCommand({
    audit: getAuditWriter(),
    ledger: getOperationLedger(),
    files: getFileStorage(),
    businessClock: getBusinessClock(),
  })
  return homeSettingsCommand
}

export function getHomeSettingsQuery(): HomeSettingsQuery {
  homeSettingsQuery ??= new PgHomeSettingsQuery()
  return homeSettingsQuery
}

/** app 對 application 只能帶型別；畫面要用的預設值、上限與句子經這裡拿（母 spec §4.3）。 */
export { describeHomeSaved, HERO_UPLOAD, HOME_DEFAULTS, HOME_LIMITS, resolveHome } from '@/application/site'
