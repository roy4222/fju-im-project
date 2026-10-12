/**
 * 網站外框設定（第三波 W3：首頁設定）的公開入口（母 spec §4.3）。
 *
 * 跨模組只能從這裡引用，而且只能帶型別；執行期的實作由 composition 注入。
 */
export type {
  HomeSettings,
  HomeSettingsField,
  HomeSettingsFields,
  HomeSettingsInput,
  NormalizedHomeSettings,
  ResolvedHome,
} from '@/application/site/home-settings'
export {
  describeHomeSaved,
  HERO_UPLOAD,
  HOME_DEFAULTS,
  HOME_LIMITS,
  HOME_STALE_MESSAGE,
  normalizeHomeSettings,
  resolveHome,
} from '@/application/site/home-settings'
export type { HomeSettingsCommand, HomeSettingsQuery, HomeSettingsReceipt, HomeSettingsSaveInput } from '@/application/site/ports'
