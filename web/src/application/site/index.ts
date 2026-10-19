/**
 * 網站外框設定（第三波 W3 首頁設定；C2-17 站內文字）的公開入口（母 spec §4.3）。
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
export type {
  FooterContactField,
  FooterContactText,
  NormalizedSiteText,
  PrivacyText,
  QuickCardKey,
  QuickCardText,
  SiteTextInput,
  SiteTextKey,
  SiteTextRow,
  SiteTexts,
  SiteTextValue,
} from '@/application/site/site-texts'
export {
  FOOTER_CONTACT_FIELDS,
  FOOTER_CONTACT_LABEL,
  isSiteTextKey,
  normalizeSiteText,
  parsePrivacyBody,
  privacyBodyOf,
  readSiteText,
  SITE_TEXT_KEYS,
  SITE_TEXT_LABEL,
  SITE_TEXT_LIMITS,
  SITE_TEXT_STALE_MESSAGE,
} from '@/application/site/site-texts'
export type {
  HomeSettingsCommand,
  HomeSettingsQuery,
  HomeSettingsReceipt,
  HomeSettingsSaveInput,
  SiteTextReceipt,
  SiteTextsCommand,
  SiteTextsQuery,
} from '@/application/site/ports'
