/**
 * 「操作紀錄」頁的讀取模型（票 36；模組 10 產品需求「系辦進操作紀錄：依角色篩選，每筆有時間、人、動作、對象、理由；
 * 不可修改」；原型 `/dashboard/admin/audit`）。
 *
 * 資料就是既有的 `audit_events`（契約 01 §4.3，只能 INSERT）。這裡只定「讀出來長什麼樣」與顯示用的中文，
 * **不讀 `payload`**：payload 是追溯用的內部欄位，規則上已經不放秘密，但畫面用不到，就不拿出來。
 * 唯一例外是核准註冊（`account.approve`）的核實說明 `payload.verificationNote`：它沒有獨立欄位，
 * 而系辦要能查「這次核准是怎麼核實的」（2026-10-08 系2，Roy 同意）。只取這一個鍵、只對這一個動作。
 */

import type { VerificationMethod } from '@/application/ops/records'

/**
 * 頁面上的角色分頁（原型：全部／管理員／老師／學生／系統）。
 * 「本人申請」收沒有角色的本人動作（學生送出註冊申請時還沒有角色）；少了它，分頁加起來會小於「全部」（系3）。
 * 除了「全部」，每一筆恰好落在一個分頁。
 */
export const AUDIT_WHO_FILTERS = ['all', 'admin', 'teacher', 'student', 'other', 'system'] as const
export type AuditWhoFilter = (typeof AUDIT_WHO_FILTERS)[number]

export const AUDIT_WHO_LABEL: Record<AuditWhoFilter, string> = {
  all: '全部',
  admin: '管理員',
  teacher: '老師',
  student: '學生',
  other: '本人申請',
  system: '系統',
}

export function normalizeAuditWho(value: unknown): AuditWhoFilter {
  const v = Array.isArray(value) ? value[0] : value
  return typeof v === 'string' && (AUDIT_WHO_FILTERS as readonly string[]).includes(v) ? (v as AuditWhoFilter) : 'all'
}

/** 最近幾天（原型「近 7 天」）與一次最多列幾筆。 */
export const AUDIT_WINDOW_DAYS = 7
export const AUDIT_PAGE_LIMIT = 200

/**
 * 搜尋字長度上限（AD-B6；trim 後 1–50 個 UTF-16 單位，即 JS 的 `.length`）。
 * 畫面欄位的 `maxlength` 也是這個計量，前後端同一把尺（補充平面字如 𠮷 算 2）；伺服器收到更長的回 `VALIDATION_FAILED`。
 */
export const AUDIT_QUERY_MAX_LENGTH = 50

/** 搜尋字不合格（trim 後超過 `AUDIT_QUERY_MAX_LENGTH` 字）。 */
export class AuditQueryInvalidError extends Error {
  readonly code = 'VALIDATION_FAILED'
  constructor() {
    super(`搜尋字最多 ${AUDIT_QUERY_MAX_LENGTH} 字。`)
  }
}

/** 網址參數 `q` 正規化：trim；空字串當作沒有搜尋（null）；超過上限丟 `AuditQueryInvalidError`。 */
export function parseAuditQuery(value: unknown): string | null {
  const v = Array.isArray(value) ? value[0] : value
  if (typeof v !== 'string') return null
  const q = v.trim()
  if (q === '') return null
  if (q.length > AUDIT_QUERY_MAX_LENGTH) throw new AuditQueryInvalidError()
  return q
}

/** 不列進「操作紀錄」的事件（目前沒有；原本排除的磁碟量測已隨 A-17 移除）。 */
export const AUDIT_EXCLUDED_ACTIONS: readonly string[] = []

export type AuditLogEntry = {
  readonly id: string
  readonly realAt: Date
  readonly actorKind: 'user' | 'system' | 'worker'
  /** 操作者顯示名稱；系統與背景工作沒有人。 */
  readonly actorName: string | null
  /** 操作當下的角色（學生／老師／管理員）；本人動作（改密碼、補資料）與系統為 null。 */
  readonly role: 'student' | 'teacher' | 'admin' | null
  readonly action: string
  readonly targetType: string
  /**
   * 對象的名字（帳號與註冊申請＝姓名、組別＝組別代碼、屆別＝「名稱（代碼）」、活動＝活動標題）；
   * 其他類型或找不到時為 null。
   */
  readonly targetName: string | null
  readonly cohortCode: string | null
  readonly cohortName: string | null
  readonly reason: string | null
  /** 核實方式（核准註冊、核發臨時密碼這類要核實身分的動作才有）。 */
  readonly verificationMethod: VerificationMethod | null
  /** 核實說明；只有核准註冊會帶（見檔頭的唯一例外）。 */
  readonly verificationNote: string | null
}

export type AuditLog = {
  /** 這一份是哪個分頁（網址參數正規化後的值）。 */
  readonly who: AuditWhoFilter
  /** 搜尋字（已 trim）；沒搜尋為 null。分頁籤數字與清單都隨它過濾。 */
  readonly q: string | null
  readonly since: Date
  readonly entries: readonly AuditLogEntry[]
  /** 各分頁的筆數（整個時間窗，不受筆數上限影響）。 */
  readonly counts: Record<AuditWhoFilter, number>
  /** 整個時間窗裡附理由的筆數（原型標題下一行的「附理由 N 筆」）。 */
  readonly withReason: number
  /** 目前分頁的筆數多於上限、只列了最近的 `AUDIT_PAGE_LIMIT` 筆。 */
  readonly truncated: boolean
}

/** 這一筆算哪個分頁（與 `pg-audit-log.ts` 的分頁 SQL 一一對應）。 */
export function auditWhoOf(entry: Pick<AuditLogEntry, 'actorKind' | 'role'>): Exclude<AuditWhoFilter, 'all'> {
  if (entry.actorKind !== 'user') return 'system'
  return entry.role ?? 'other'
}

const ACTION_LABEL: Record<string, string> = {
  // 帳號（模組 01）
  'account.approve': '核准註冊',
  'account.reject': '退回註冊',
  'account.disable': '停用帳號',
  'account.restore': '恢復帳號',
  'account.bulk_disable': '批次停用帳號',
  'account.export': '匯出帳號名單',
  'account.grant_role': '設為管理員',
  'account.revoke_role': '取消管理員',
  'account.create_teacher': '新增老師',
  'account.preauthorize_teacher': '預先建立老師帳號',
  'account.issue_temporary_password': '核發臨時密碼',
  'account.issue_temporary_password_failed': '臨時密碼核發失敗',
  'account.complete_teacher_profile': '老師補完資料',
  'account.update_contact': '更新聯絡資料',
  'account.change_password': '變更密碼',
  'account.set_password': '設定密碼',
  'account.link_google': '連結 Google 登入',
  'account.bind_google_preauthorized': '預先建立的老師帳號綁定 Google',
  'account.repair_orphan': '替尚未設定身分的帳號補上身分',
  'account.seed_first_admin': '建立第一位管理員',
  'account.seed_e2e_admin': '建立測試管理員帳號',
  'account.deidentify': '刪除個人資料（保留紀錄）',
  'account.session_revocation.reconcile_limit': '登出同步未完成',
  // B 階段預先登記（A-08 一次登記，後面的票不必再碰這張表）：SH-9／AD-B2 頭像、VB-14 清理未完成註冊。
  'account.avatar_update': '更換頭像',
  'account.avatar_reset': '系辦重設頭像',
  'account.stale_signup_scrubbed': '清理未完成註冊帳號',
  'registration.apply': '送出註冊申請',
  'registration.revise': '修改註冊申請',
  'registration.resubmit': '重新送出註冊申請',
  'registration.auto_approve': '自動開通註冊（Google Email 與名單相同）',
  'roster.import': '匯入學生名單',
  'session.revoke': '強制登出',
  // 屆別與時間軸（模組 02）
  'cohort.create': '新增屆別',
  'cohort.activate': '屆別轉為進行中',
  'cohort.set_default_working': '設定後台預設查看的屆別',
  'cohort.set_registration_open': '設定新註冊學生加入的屆別',
  'cohort.set_grouping_settings': '修改分組設定',
  'cohort.save_schedule': '儲存時間軸',
  'cohort.activity.create': '新增活動',
  'cohort.activity.update': '修改活動',
  'cohort.activity.cancel': '取消活動',
  'cohort.activity.delete': '刪除活動',
  'cohort.activated': '屆別轉為進行中',
  // B 階段 A-09 封存／解封（預先登記）。
  'cohort.archive': '封存屆別',
  'cohort.unarchive': '解除封存屆別',
  'activity.deleted': '刪除活動',
  'business_clock.set': '調整測試用時間',
  // 分組、指導與產學（模組 03）
  'group.dissolve': '解散組別',
  'group.establish': '組別成立',
  'group.export': '匯出組別名單',
  'group.leader.change': '換組長',
  'group.member.add': '加入組員',
  'group.member.remove': '移出組員',
  'group.propose': '發起提案',
  'group.proposal.create': '發起提案',
  'group.proposal.confirm': '確認提案',
  'group.proposal.decline': '婉拒提案',
  'group.proposal.terminate': '組隊提案沒有成立',
  'group.proposal.void': '作廢提案',
  'group.proposal.withdraw': '撤回提案',
  'group.proposal.withdraw_confirmation': '撤回確認',
  'group.set_open_to_join': '設定公開找組員',
  'group.type.change': '改組別類型',
  'advisor.assign': '指派指導老師',
  'advisor.reassign': '重派指導老師',
  'advisor.unassign': '解除指導老師',
  'advisor.claim': '擔任產學組指導老師',
  'advisor.batch': '批次指派指導老師',
  'advisor.batch_assign': '批次指派指導老師',
  'opportunity.create': '建立合作案',
  'opportunity.update': '修改合作案',
  'opportunity.publish': '發布合作案',
  'opportunity.republish': '重新發布合作案',
  'opportunity.withdraw': '下架合作案',
  'opportunity.link': '連結合作案',
  'opportunity.unlink': '解除合作案連結',
  'opportunity.switch': '換合作案',
  'opportunity.delete': '刪除合作案',
  'opportunity.deleted': '刪除合作案',
  'opportunity.published': '發布合作案',
  'opportunity.republished': '重新發布合作案',
  'opportunity.withdrawn': '下架合作案',
  'opportunity.linked': '連結合作案',
  'opportunity.unlinked': '解除合作案連結',
  'opportunity.switched': '換合作案',
  // 專題事務與繳交（模組 04、05）
  'item.create': '建立公告或作業',
  'item.save_draft': '儲存公告或作業草稿',
  'item.publish': '發布公告或作業',
  'item.update_published': '修改已發布的公告或作業',
  'item.withdraw': '撤回公告或作業',
  'item.archive': '下架公告或作業',
  'item.republish': '重新發布公告或作業',
  'item.pin': '置頂公告或作業',
  'item.unpin': '取消置頂公告或作業',
  'item.delete': '刪除公告或作業',
  'item.deleted': '刪除公告或作業',
  // B 階段 A-14 規則章節排序（預先登記）。
  'item.rule_moved': '調整規則章節順序',
  'item.published': '發布公告或作業',
  'item.withdrawn': '撤回公告或作業',
  'item.archived': '下架公告或作業',
  'item.republished': '重新發布公告或作業',
  'item.updated': '修改公告或作業',
  'item.announced': '發出重要公告通知',
  'submission.submitted': '正式送出繳交',
  'submission.reopen': '開放補交',
  'submission.reopened': '開放補交',
  // B 階段 A-08 設免繳／恢復（冪等鍵與稽核代碼同名）。
  'submission.exempt_set': '設免繳',
  'submission.exempt_cleared': '恢復需繳交',
  'submission.save_draft': '儲存繳交草稿',
  'submission.submit': '正式送出繳交',
  'submission.set_advisor_visibility': '設定指導老師閱覽',
  'submission.advisor_visibility.enable': '開放指導老師閱覽',
  'submission.advisor_visibility.disable': '關閉指導老師閱覽',
  // 評分（模組 06）
  'grading.scheme_create': '建立評分規則',
  'grading.scheme_publish': '發布評分規則',
  'grading.scheme_apply': '套用新版評分規則',
  'grading.requirement_set': '設定每組評分老師人數',
  'grading.assign': '指派評分老師',
  'grading.assignment_remove': '移除評分老師',
  'grading.save_draft': '儲存評分草稿',
  'grading.submit_final': '送出評分',
  'grading.return': '退回評分',
  'grading.override': '更正成績',
  'grading.override_resolve': '重新確認更正',
  'grading.override_review': '重新確認更正',
  'grading.export': '匯出成績',
  // B 階段 A-01 結算（預先登記）。
  'grading.settle': '結算成績',
  'grading.release': '解除成績結算',
  // 簽核與精選（模組 07、09）
  'signoff.version_create': '建立站內同意書',
  'signoff.version_reopen': '重開同意書新版',
  'signoff.version_reset': '重新收集同意書',
  'signoff.version_supersede': '同意書被新版取代',
  'signoff.version_void': '作廢同意書',
  'signoff.respond': '回覆同意書',
  'signoff.remind': '提醒未同意者',
  'signoff.export': '匯出同意書紀錄',
  'showcase.draft_create': '建立成果展示草稿',
  'showcase.draft_update': '修改成果展示草稿',
  'showcase.publish': '發布成果展示',
  'showcase.published': '發布成果展示',
  'showcase.withdraw': '下架成果展示',
  'showcase.withdrawn': '下架成果展示',
  'showcase.republish': '重新發布成果展示',
  'showcase.republished': '重新發布成果展示',
  'showcase.award_set': '設定成果展示獎項',
  'showcase.delete': '刪除成果展示',
  'showcase.deleted': '刪除成果展示',
  'showcase.backfill_create': '補登歷屆成果展示',
  'showcase.publish_update': '發布成果展示更新',
  'showcase.update_published': '發布成果展示更新',
  'showcase.home_position_set': '調整成果展示首頁輪播順序',
  // 首頁設定（第三波 W3）
  'home.update': '更新首頁設定',
  'home.updated': '更新首頁設定',
  'home.reset': '首頁設定恢復預設',
  // 維運（模組 10）
  'ops.worker_alert': '背景工作警示',
  'notification.test.send': '發送測試通知',
  'demo.seed': '放入示範資料',
  'demo.remove': '移除示範資料',
}

/** 對照表沒有的代碼一律顯示這個字；原代碼放在滑過提示（`auditActionTitle`），不直接露出英文（第三波 Q26）。 */
export const AUDIT_UNKNOWN_ACTION_LABEL = '其他操作'

/** 這個代碼在對照表裡有沒有中文（單元測試用來保證程式裡出現的代碼都登記過）。 */
export function hasAuditActionLabel(action: string): boolean {
  return Object.hasOwn(ACTION_LABEL, action)
}

/** 動作的中文；沒登記的顯示「其他操作」（新功能忘了登記也不會讓頁面壞掉或露出英文代碼）。 */
export function auditActionLabel(action: string): string {
  return hasAuditActionLabel(action) ? ACTION_LABEL[action]! : AUDIT_UNKNOWN_ACTION_LABEL
}

/** 滑過提示：只有沒登記的動作才帶原代碼，方便回報問題時對得上。 */
export function auditActionTitle(action: string): string | undefined {
  return hasAuditActionLabel(action) ? undefined : action
}

const TARGET_TYPE_LABEL: Record<string, string> = {
  user: '帳號',
  account_directory: '帳號名單',
  registration_application: '註冊申請',
  roster_version: '匯入的學生名單',
  cohort: '屆別',
  business_clock: '測試用時間',
  home_settings: '首頁設定',
  project_event: '活動',
  group: '組別',
  group_roster: '組別名單',
  group_proposal: '分組提案',
  industry_opportunity: '合作案',
  item: '公告與作業',
  submission: '繳交',
  evaluation: '評分',
  gradebook: '成績表',
  grading_scheme_version: '評分規則',
  signoff_version: '站內同意書',
  showcase_entry: '成果展示',
  storage: '儲存空間',
}

/** 對象類型的中文對照（[代碼, 中文]），給稽核查詢在 SQL 裡組出和畫面一樣的對象文字（搜尋用）。 */
export const AUDIT_TARGET_TYPE_LABEL_ENTRIES: readonly (readonly [string, string])[] = Object.entries(TARGET_TYPE_LABEL)

export function auditTargetTypeLabel(targetType: string): string {
  return TARGET_TYPE_LABEL[targetType] ?? targetType
}

/** 對象那一欄的文字：「帳號・王小明」「組別・G03（115 學年）」；沒有名字就只寫類型。屆別有名稱就寫名稱，沒有才寫代碼。 */
export function describeAuditTarget(
  entry: Pick<AuditLogEntry, 'targetType' | 'targetName' | 'cohortCode'> & Partial<Pick<AuditLogEntry, 'cohortName'>>,
): string {
  const type = auditTargetTypeLabel(entry.targetType)
  const name = entry.targetName?.trim()
  const cohortText = entry.cohortName?.trim() || entry.cohortCode
  const cohort = cohortText && entry.targetType !== 'cohort' ? `（${cohortText}）` : ''
  return `${name ? `${type}・${name}` : type}${cohort}`
}
