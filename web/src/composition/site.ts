import 'server-only'
import { cache } from 'react'
import type { HomeSettingsCommand, HomeSettingsQuery, SiteTexts, SiteTextsCommand, SiteTextsQuery } from '@/application/site'
import { getBusinessClock } from '@/composition/cohorts'
import { getAuditWriter, getFileStorage, getOperationLedger } from '@/composition/ops'
import { PgHomeSettingsCommand, PgHomeSettingsQuery } from '@/infrastructure/site/pg-home-settings'
import { PgSiteTextsCommand, PgSiteTextsQuery } from '@/infrastructure/site/pg-site-texts'

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

/** 站內文字（C2-17）：頁尾聯絡、三張卡、隱私權政策；存了就生效，每個前台頁都讀。 */
let siteTextsCommand: SiteTextsCommand | undefined
let siteTextsQuery: SiteTextsQuery | undefined

export function getSiteTextsCommand(): SiteTextsCommand {
  siteTextsCommand ??= new PgSiteTextsCommand({
    audit: getAuditWriter(),
    ledger: getOperationLedger(),
    businessClock: getBusinessClock(),
  })
  return siteTextsCommand
}

export function getSiteTextsQuery(): SiteTextsQuery {
  siteTextsQuery ??= new PgSiteTextsQuery()
  return siteTextsQuery
}

/** 同一次 render 只查一次（外殼的頁尾、首頁三張卡、隱私權頁都讀同一份）。 */
export const loadSiteTexts = cache((): Promise<SiteTexts> => getSiteTextsQuery().all())

/** app 對 application 只能帶型別；畫面要用的預設值、上限與句子經這裡拿（母 spec §4.3）。 */
export { describeHomeSaved, HERO_UPLOAD, HOME_DEFAULTS, HOME_LIMITS, resolveHome } from '@/application/site'
export { privacyBodyOf } from '@/application/site'
