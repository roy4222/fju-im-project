import type { ResolvedActor } from '@/application/accounts'
import { normalizeReason } from '@/application/groups/members'
import { GROUP_TYPE_LABEL, GROUP_TYPES, type GroupType } from '@/application/groups/proposals'
import { err, type Err } from '@/shared/result'

/**
 * 產學合作案、組別與合作案的連結、組長改組別類型的型別與純規則（票 20；產品模組 03 §4「5.3」「6.1–6.3」）。
 *
 * 這個檔沒有資料庫：欄位怎麼整理、誰看得到聯絡資訊、組長什麼時候能自己改類型，都在這裡單獨測。
 * 交易、鎖、唯一約束與「查詢層不選私有欄位」在 infrastructure（`pg-opportunities.ts`）。
 *
 * 可見性（6.1、6.2）：
 * - 列表與詳情要登入；訪客看不到。
 * - 公司、部門、內容、條件、負責老師、發布日：登入者可見（已發布的）。
 * - 地址、聯絡人、電話、Email：只有案主（負責老師）與系辦。備註建立時選「登入者可見」或「內部」。
 * - 草稿只有案主與系辦看得到；下架後列表不再顯示，已連結組別的組員仍看得到原本已發布的內容（6.3）。
 */

export type OpportunityStatus = 'draft' | 'published' | 'withdrawn'
export const OPPORTUNITY_STATUS_LABEL: Record<OpportunityStatus, string> = {
  draft: '草稿',
  published: '已發布',
  withdrawn: '已下架',
}

export type NotesVisibility = 'signed_in' | 'internal'
export const NOTES_VISIBILITY_LABEL: Record<NotesVisibility, string> = {
  signed_in: '登入者可見',
  internal: '只有你與系辦',
}

/** 欄位上限（6.2「後端用合理安全上限，UI 必須適合段落輸入」）。 */
export const OPPORTUNITY_LIMITS = {
  companyName: 100,
  department: 100,
  content: 5000,
  requirements: 5000,
  notes: 2000,
  address: 200,
  contactName: 50,
  contactPhone: 30,
  contactEmail: 254,
} as const

export type OpportunityField = keyof typeof OPPORTUNITY_LIMITS

export const OPPORTUNITY_FIELD_LABEL: Record<OpportunityField, string> = {
  companyName: '公司名稱',
  department: '需求部門',
  content: '專題／合作內容',
  requirements: '對學生的條件／需求',
  notes: '備註',
  address: '公司地址',
  contactName: '聯絡人',
  contactPhone: '聯絡電話',
  contactEmail: '聯絡 Email',
}

/** 表單送來的原樣（全部是字串；沒填是空字串）。 */
export type OpportunityInput = {
  readonly companyName: string
  readonly department: string
  readonly content: string
  readonly requirements: string
  readonly notes: string
  readonly notesVisibility: string
  readonly address: string
  readonly contactName: string
  readonly contactPhone: string
  readonly contactEmail: string
}

/** 整理後可以存的樣子：選填欄位沒填是 null；`requirements` 表的欄位是 NOT NULL，沒填存空字串。 */
export type NormalizedOpportunity = {
  readonly companyName: string
  readonly department: string
  readonly content: string
  readonly requirements: string
  readonly notes: string | null
  readonly notesVisibility: NotesVisibility
  readonly address: string | null
  readonly contactName: string | null
  readonly contactPhone: string | null
  readonly contactEmail: string | null
}

const REQUIRED: readonly OpportunityField[] = ['companyName', 'department', 'content']
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_PATTERN = /^[0-9 ()+#\-－]{6,}$/

function fieldError(field: OpportunityField, message: string): Err {
  return err('VALIDATION_FAILED', message, { details: { field } })
}

/** 檢查必填、長度、Email 與電話格式；內容照打的字存（輸出時才清洗 HTML）。 */
export function normalizeOpportunityInput(input: OpportunityInput): { ok: true; value: NormalizedOpportunity } | Err {
  const raw = (field: OpportunityField) => String(input[field] ?? '').replace(/\r\n?/g, '\n')
  const values = {} as Record<OpportunityField, string>
  for (const field of Object.keys(OPPORTUNITY_LIMITS) as OpportunityField[]) {
    const value = raw(field).trim()
    if (REQUIRED.includes(field) && value === '') return fieldError(field, `請填${OPPORTUNITY_FIELD_LABEL[field]}。`)
    if (value.length > OPPORTUNITY_LIMITS[field]) {
      return fieldError(field, `${OPPORTUNITY_FIELD_LABEL[field]}最多 ${OPPORTUNITY_LIMITS[field]} 個字。`)
    }
    values[field] = value
  }
  if (values.contactEmail && !EMAIL_PATTERN.test(values.contactEmail)) {
    return fieldError('contactEmail', '聯絡 Email 格式不對，例如 name@company.com。')
  }
  if (values.contactPhone && !PHONE_PATTERN.test(values.contactPhone)) {
    return fieldError('contactPhone', '聯絡電話只能有數字、空格、括號、+ 與 -。')
  }
  const visibility = String(input.notesVisibility ?? '')
  if (visibility !== 'signed_in' && visibility !== 'internal') {
    return err('VALIDATION_FAILED', '請選備註要給誰看。', { details: { field: 'notesVisibility' } })
  }
  const optional = (value: string) => (value === '' ? null : value)
  return {
    ok: true,
    value: {
      companyName: values.companyName,
      department: values.department,
      content: values.content,
      requirements: values.requirements,
      notes: optional(values.notes),
      notesVisibility: visibility,
      address: optional(values.address),
      contactName: optional(values.contactName),
      contactPhone: optional(values.contactPhone),
      contactEmail: optional(values.contactEmail),
    },
  }
}

/** 列表摘要：內容第一段的前 80 字（純文字；有標籤就拿掉，列表不輸出 HTML）。 */
export function opportunitySummary(content: string, max = 80): string {
  const text = content
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 合作案在畫面上的名稱（沒有獨立標題欄：公司＋部門）。 */
export function opportunityName(o: { readonly companyName: string; readonly department: string }): string {
  return `${o.companyName}・${o.department}`
}

// ── 誰看得到什麼 ──────────────────────────────────────────────────────────

function isActiveAdmin(actor: ResolvedActor): boolean {
  return actor.kind === 'authenticated' && actor.status === 'active' && actor.roles.includes('admin')
}

/** 能不能看合作案（列表與詳情）：已登入、帳號正常、有任一角色（6.1：登入後內容，訪客看不到）。 */
export function canViewOpportunities(actor: ResolvedActor): boolean {
  return actor.kind === 'authenticated' && actor.status === 'active' && !actor.mustChangePassword && actor.roles.length > 0
}

/** 能不能看、改這一案的私有欄位（地址、聯絡人、電話、Email、內部備註）：案主本人或系辦。 */
export function canManageOpportunity(actor: ResolvedActor, ownerTeacherUserId: string): boolean {
  if (!canViewOpportunities(actor) || actor.kind !== 'authenticated') return false
  return isActiveAdmin(actor) || (actor.userId === ownerTeacherUserId && actor.roles.includes('teacher'))
}

// ── 指令的輸入與回執 ──────────────────────────────────────────────────────

export type CreateOpportunityInput = OpportunityInput & {
  /** true＝儲存並發布；false＝儲存草稿。 */
  readonly publish: boolean
}

export type UpdateOpportunityInput = OpportunityInput & {
  readonly opportunityId: string
  /** 編輯畫面打開時的版本；別人先改過就 `CONFLICT`。 */
  readonly revision: number
}

export type OpportunityStatusInput = {
  readonly opportunityId: string
  readonly revision: number
}

export type OpportunityAction = 'created' | 'updated' | 'published' | 'withdrawn' | 'republished'

export type OpportunityReceipt = {
  readonly opportunityId: string
  readonly name: string
  readonly action: OpportunityAction
  readonly status: OpportunityStatus
  readonly revision: number
}

export function describeOpportunityReceipt(receipt: OpportunityReceipt): string {
  switch (receipt.action) {
    case 'created':
      return receipt.status === 'published'
        ? `已發布「${receipt.name}」：登入的學生與老師看得到公開欄位，聯絡資訊只有你與系辦看得到。`
        : `已儲存草稿「${receipt.name}」：只有你與系辦看得到，發布後學生才看得到。`
    case 'updated':
      return `已儲存「${receipt.name}」的修改。`
    case 'published':
      return `已發布「${receipt.name}」。`
    case 'republished':
      return `已重新發布「${receipt.name}」：列表恢復顯示；以前解除的組別連結不會自動恢復。`
    case 'withdrawn':
      return `已下架「${receipt.name}」：列表不再顯示、不接受新連結；已連結的組別保留關係並標示「合作案已下架」。`
  }
}

/** 組長連結或換案（管理員也可以）。`reason` 只有換案時必填（6.3「解除、換案保留原因」）。 */
export type LinkOpportunityInput = {
  readonly groupId: string
  /** 畫面打開時的組別版本。 */
  readonly revision: number
  readonly opportunityId: string
  readonly reason: string
}

/** 案主或系辦解除（理由必填，通知全組與案主）。 */
export type UnlinkOpportunityInput = {
  readonly linkId: string
  readonly reason: string
}

export type LinkChange = 'linked' | 'switched' | 'unlinked'

export type LinkReceipt = {
  readonly groupId: string
  readonly groupCode: string
  readonly change: LinkChange
  readonly opportunityName: string
  /** 換案時的原合作案；其他是 null。 */
  readonly previousOpportunityName: string | null
}

export function describeLinkReceipt(receipt: LinkReceipt): string {
  switch (receipt.change) {
    case 'linked':
      return `${receipt.groupCode} 已連結「${receipt.opportunityName}」。連結代表選用這個題目，不代表企業或老師已正式承諾合作。`
    case 'switched':
      return `${receipt.groupCode} 已從「${receipt.previousOpportunityName}」換到「${receipt.opportunityName}」；全組與兩位案主老師會收到通知。`
    case 'unlinked':
      return `已解除 ${receipt.groupCode} 與「${receipt.opportunityName}」的連結；該組組員與案主會收到通知。`
  }
}

/** 換案或解除的理由：沿用管理員動作的理由規則（必填、上限 200 字）。 */
export function normalizeLinkReason(reason: string, what: '換案' | '解除連結'): { ok: true; value: string } | Err {
  return normalizeReason(reason, what)
}

// ── 組別類型 ──────────────────────────────────────────────────────────────

/**
 * 組長自己改類型的三個條件（2026-09-12 定案；5.3）：在成組期內、尚未指派主指導、未連結合作案
 * （「組別已成立」由有組別這件事本身保證）。回不符合的條件，全部符合回空陣列。
 */
export type LeaderTypeChangeFacts = {
  readonly inGroupingPeriod: boolean
  readonly hasAdvisor: boolean
  readonly hasLink: boolean
}

export function leaderTypeChangeBlockers(facts: LeaderTypeChangeFacts): string[] {
  const blockers: string[] = []
  if (!facts.inGroupingPeriod) blockers.push('成組期已結束')
  if (facts.hasAdvisor) blockers.push('已經有指導老師')
  if (facts.hasLink) blockers.push('已經連結合作案')
  return blockers
}

export type ChangeGroupTypeInput = {
  readonly groupId: string
  readonly revision: number
  readonly groupType: string
  /** 管理員必填；組長可以不填。 */
  readonly reason: string
}

export type GroupTypeReceipt = {
  readonly groupId: string
  readonly groupCode: string
  readonly from: GroupType
  readonly to: GroupType
  /** 管理員改類型時提醒的既有關聯（保留、不刪）。 */
  readonly keptRelations: readonly string[]
}

export function describeGroupTypeReceipt(receipt: GroupTypeReceipt): string {
  const base = `${receipt.groupCode} 的組別類型已從「${GROUP_TYPE_LABEL[receipt.from]}」改成「${GROUP_TYPE_LABEL[receipt.to]}」。`
  return receipt.keptRelations.length > 0 ? `${base}保留：${receipt.keptRelations.join('、')}。` : base
}

export function parseGroupType(value: string): GroupType | null {
  return (GROUP_TYPES as readonly string[]).includes(value) ? (value as GroupType) : null
}

// ── 查詢的回傳 ────────────────────────────────────────────────────────────

/** 列表卡片：只有公開欄位。 */
export type OpportunityCard = {
  readonly id: string
  readonly companyName: string
  readonly department: string
  readonly summary: string
  readonly ownerUserId: string
  readonly ownerName: string
  readonly status: OpportunityStatus
  /** 最近一次發布的業務時間；草稿是 null。 */
  readonly publishedAt: Date | null
  /** 目前連結的組別數（有效連結）。 */
  readonly linkedGroupCount: number
}

export type OpportunityContact = {
  readonly address: string | null
  readonly contactName: string | null
  readonly contactPhone: string | null
  readonly contactEmail: string | null
}

export type LinkedGroupRef = {
  readonly linkId: string
  readonly groupId: string
  readonly groupCode: string
  readonly cohortCode: string
  readonly linkedAt: Date
}

/** 詳情：正文三段**已經過伺服器端清洗**（`renderBodyHtml`），畫面直接輸出。 */
export type OpportunityDetail = OpportunityCard & {
  readonly contentHtml: string
  readonly requirementsHtml: string
  /** 備註：內部備註只給案主與系辦；其他人是 null。 */
  readonly notesHtml: string | null
  readonly notesVisibility: NotesVisibility
  /** 私有欄位：只有案主與系辦是物件，其他人一律 null（查詢層就不選）。 */
  readonly contact: OpportunityContact | null
  readonly linkedGroups: readonly LinkedGroupRef[]
  /** 看的人能不能管理這一案（編輯、下架、解除連結）。 */
  readonly canManage: boolean
}

/**
 * 打開一案的結果：
 * - `visible`：看得到（已發布；或案主與系辦看任何狀態）。
 * - `withdrawn_linked`：已下架，但看的人所在組別仍連結著它——看原本已發布的公開欄位，標示「合作案已下架」。
 * - `withdrawn`：已下架，其他人看到下架說明（不帶內容）。
 * - `need_login`：訪客。
 * - `not_found`：不存在，或是別人的草稿（不透露草稿存在）。
 */
export type OpportunityPage =
  | { readonly access: 'visible' | 'withdrawn_linked'; readonly opportunity: OpportunityDetail }
  | { readonly access: 'withdrawn' | 'need_login' | 'not_found' }

/** 案主與系辦的管理列：含編輯用的原始欄位與目前的連結。 */
export type ManagedOpportunity = {
  readonly id: string
  readonly ownerUserId: string
  readonly ownerName: string
  readonly status: OpportunityStatus
  readonly revision: number
  readonly publishedAt: Date | null
  readonly withdrawnAt: Date | null
  readonly fields: NormalizedOpportunity
  readonly links: readonly LinkedGroupRef[]
}

/** 組別目前連結的合作案（組別頁、分組總覽、匯出都用）。 */
export type GroupOpportunityLink = {
  readonly linkId: string
  readonly opportunityId: string
  readonly name: string
  readonly status: OpportunityStatus
}
