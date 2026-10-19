import type { FooterContactText } from '@/application/site'

/**
 * 系辦聯絡資料的預設值，全站只寫這一份（第 1 批 Q48-b、設計方案 §3.2）：首頁快速入口、頁尾、忘記密碼頁、產學頁都讀這裡。
 * 聯絡資料照系網（第三波 W3；Q2＋電話）。不放 Email、傳真、辦公時間：官方來源不一致。
 *
 * C2-17 起系辦可在前台改（`site_texts.footer_contact`）：頁尾、首頁第三張卡、隱私權頁用 `resolveSiteContact(row)`；
 * 沒有列就是這份預設，跟改版前一字不差。這個檔保持純值（e2e 從 Node 直接 import），不帶 server-only。
 */
export const SITE_CONTACT = {
  department: '輔仁大學資訊管理學系',
  address: '242 新北市新莊區中正路 510 號 利瑪竇大樓 LM306',
  phone: '02-2905-2666',
  phoneHref: 'tel:+886229052666',
  siteLabel: 'im.fju.edu.tw',
  siteHref: 'https://www.im.fju.edu.tw/',
  slogan: '透過機測、專題及產業實習讓學生動手做。',
  officeNote: '專題相關事務請洽系辦公室',
  industryNote: '業界合作或產學洽詢，也請直接聯絡系辦。',
} as const satisfies FooterContactText & { phoneHref: string }

export type SiteContact = FooterContactText & { readonly phoneHref: string }

/** 預設值可改的那幾欄（存進 `site_texts.footer_contact` 的 JSON）。 */
export const SITE_CONTACT_DEFAULTS: FooterContactText = {
  department: SITE_CONTACT.department,
  address: SITE_CONTACT.address,
  phone: SITE_CONTACT.phone,
  siteLabel: SITE_CONTACT.siteLabel,
  siteHref: SITE_CONTACT.siteHref,
  slogan: SITE_CONTACT.slogan,
  officeNote: SITE_CONTACT.officeNote,
  industryNote: SITE_CONTACT.industryNote,
}

/**
 * 電話連結：台灣市話／手機寫法（`02-2905-2666`、`0912-345-678`）轉 `tel:+886…`；其他寫法只去掉分隔符號。
 * 跟預設的 `phoneHref` 同一條規則（`telHref(SITE_CONTACT.phone) === SITE_CONTACT.phoneHref`）。
 */
export function telHref(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '')
  if (digits.startsWith('+')) return `tel:${digits}`
  if (/^0\d{8,9}$/.test(digits)) return `tel:+886${digits.slice(1)}`
  return `tel:${digits}`
}

/** 資料庫有列就用那一列，沒有就是預設；`phoneHref` 由電話算出來。 */
export function resolveSiteContact(row: FooterContactText | null | undefined): SiteContact {
  const value = row ?? SITE_CONTACT_DEFAULTS
  return { ...value, phoneHref: row ? telHref(value.phone) : SITE_CONTACT.phoneHref }
}
