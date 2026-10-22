import type { AvatarUser } from '@/application/accounts/avatar'
import { hasControlChars, isValidEmail } from '@/application/accounts/registration'
import { err, type Err } from '@/shared/result'
import { charLength } from '@/shared/text'

/**
 * 學生名片卡（C3 設計方案 §4；票 C3-07）：一句話自介、技能、聯絡 Email、公開找隊員。
 *
 * 資料都在 `user_profiles`（`bio`、`skills`、`contact_email`、`open_to_join`）；這裡只放規則與型別，
 * 寫入在 `infrastructure/accounts/profile-card-command.ts`。
 */

/** 一句話自介的字數上限（資料庫也有 CHECK `length(bio) <= 50`）。 */
export const BIO_MAX_LENGTH = 50
/** 技能最多幾個、每個最多幾字。 */
export const SKILL_MAX_COUNT = 8
export const SKILL_MAX_LENGTH = 12

/** 預設技能（可勾選；不進資料庫，自訂的跟預設一樣存成字串）。 */
export const SKILL_PRESETS: readonly string[] = [
  '前端',
  '後端',
  '資料庫',
  '資料分析',
  'AI',
  'UI 設計',
  '簡報',
  '企劃',
  'Python',
  'JavaScript',
  'Figma',
]

/** 一個人的名片（本人看的版本）。不是學生就沒有名片。 */
export type ProfileCard = AvatarUser & {
  readonly studentNo: string | null
  readonly departmentClass: string | null
  readonly bio: string
  readonly skills: readonly string[]
  readonly contactEmail: string
  readonly openToJoin: boolean
  /** 已經有組別時是 false：「公開找隊員」開關 disabled。 */
  readonly canOpenToJoin: boolean
  readonly revision: number
}

export type ProfileCardInput = {
  readonly bio: string
  readonly skills: readonly string[]
  readonly contactEmail: string
  readonly openToJoin: boolean
}

/** 字數照「字」算（中文、emoji 各一個），跟 PostgreSQL 的 `length()` 一樣以 code point 計。 */
export function textLength(value: string): number {
  return charLength(value)
}

function invalid(field: 'bio' | 'skills' | 'contactEmail', message: string): Err {
  return err('VALIDATION_FAILED', message, { details: { field } })
}

/**
 * 整理並驗證名片（AC-C3-07）：去前後空白；技能去空白後去重（重複的不報錯）、空的略過；
 * 自介最多 50 字、技能最多 8 個、每個最多 12 字；聯絡 Email 用註冊同一套規則。
 */
export function normalizeProfileCard(input: ProfileCardInput): { ok: true; value: ProfileCardInput & { skills: string[] } } | Err {
  const bio = input.bio.trim()
  if (textLength(bio) > BIO_MAX_LENGTH) return invalid('bio', `自介最多 ${BIO_MAX_LENGTH} 字。`)
  if (hasControlChars(bio)) return invalid('bio', '自介不能換行或含特殊控制字元。')

  const skills: string[] = []
  for (const raw of input.skills) {
    const skill = raw.trim()
    if (!skill || skills.includes(skill)) continue
    if (textLength(skill) > SKILL_MAX_LENGTH) return invalid('skills', `每個技能最多 ${SKILL_MAX_LENGTH} 字。`)
    if (hasControlChars(skill)) return invalid('skills', '技能不能含特殊控制字元。')
    skills.push(skill)
  }
  if (skills.length > SKILL_MAX_COUNT) return invalid('skills', `最多 ${SKILL_MAX_COUNT} 個技能。`)

  const contactEmail = input.contactEmail.trim().toLowerCase()
  if (!contactEmail) return invalid('contactEmail', '請填聯絡 Email。')
  if (!isValidEmail(contactEmail)) return invalid('contactEmail', '聯絡 Email的格式不對。')

  return { ok: true, value: { bio, skills, contactEmail, openToJoin: input.openToJoin } }
}
