/**
 * 「操作紀錄」頁的讀取模型（票 36；模組 10 產品需求「系辦進操作紀錄：依角色篩選，每筆有時間、人、動作、對象、理由；
 * 不可修改」；原型 `/dashboard/admin/audit`）。
 *
 * 資料就是既有的 `audit_events`（契約 01 §4.3，只能 INSERT）。這裡只定「讀出來長什麼樣」與顯示用的中文，
 * **不讀 `payload`**：payload 是追溯用的內部欄位，規則上已經不放秘密，但畫面用不到，就不拿出來。
 */

/** 頁面上的角色分頁（原型：全部／管理員／老師／學生／系統）。 */
export const AUDIT_WHO_FILTERS = ['all', 'admin', 'teacher', 'student', 'system'] as const
export type AuditWhoFilter = (typeof AUDIT_WHO_FILTERS)[number]

export const AUDIT_WHO_LABEL: Record<AuditWhoFilter, string> = {
  all: '全部',
  admin: '管理員',
  teacher: '老師',
  student: '學生',
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
 * 不列進「操作紀錄」的事件：背景工作每小時寫一筆的磁碟量測（票 28 暫存在 `audit_events`，
 * 等 `storage_stats` 表補上就搬走）。它是量測、不是誰做的操作，列出來會把一週 168 筆洗滿整頁。
 */
export const AUDIT_EXCLUDED_ACTIONS: readonly string[] = ['storage.measured']

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
  /** 對象的名字（帳號＝姓名、組別＝組別代碼、屆別＝屆別代碼）；其他類型或找不到時為 null。 */
  readonly targetName: string | null
  readonly cohortCode: string | null
  readonly reason: string | null
}

export type AuditLog = {
  /** 這一份是哪個分頁（網址參數正規化後的值）。 */
  readonly who: AuditWhoFilter
  readonly since: Date
  readonly entries: readonly AuditLogEntry[]
  /** 各分頁的筆數（整個時間窗，不受筆數上限影響）。 */
  readonly counts: Record<AuditWhoFilter, number>
  /** 整個時間窗裡附理由的筆數（原型標題下一行的「附理由 N 筆」）。 */
  readonly withReason: number
  /** 目前分頁的筆數多於上限、只列了最近的 `AUDIT_PAGE_LIMIT` 筆。 */
  readonly truncated: boolean
}

/** 這一筆算哪個分頁。 */
export function auditWhoOf(entry: Pick<AuditLogEntry, 'actorKind' | 'role'>): Exclude<AuditWhoFilter, 'all'> | null {
  if (entry.actorKind !== 'user') return 'system'
  return entry.role
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
  'account.preauthorize_teacher': '預授權老師',
  'account.issue_temporary_password': '核發臨時密碼',
  'account.issue_temporary_password_failed': '臨時密碼核發失敗',
  'account.complete_teacher_profile': '老師補完資料',
  'account.update_contact': '更新聯絡資料',
  'account.change_password': '變更密碼',
  'account.set_password': '設定密碼',
  'account.link_google': '連結 Google 登入',
  'account.bind_google_preauthorized': '預授權老師綁定 Google',
  'account.repair_orphan': '補建孤兒帳號',
  'account.seed_first_admin': '建立第一位管理員',
  'account.session_revocation.reconcile_limit': '登出同步未完成',
  'registration.apply': '送出註冊申請',
  'registration.revise': '修改註冊申請',
  'registration.resubmit': '重新送出註冊申請',
  'roster.import': '匯入名單',
  'session.revoke': '強制登出',
  // 屆別與時間軸（模組 02）
  'cohort.create': '新增屆別',
  'cohort.activate': '屆別轉為進行中',
  'cohort.set_default_working': '設定預設工作屆別',
  'cohort.set_registration_open': '設定開放註冊屆別',
  'cohort.set_grouping_settings': '修改分組設定',
  'cohort.save_schedule': '儲存時間軸',
  'cohort.activity.create': '新增活動',
  'cohort.activity.update': '修改活動',
  'cohort.activity.cancel': '取消活動',
  'business_clock.set': '調整模擬時鐘',
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
  'group.proposal.terminate': '終止提案',
  'group.proposal.void': '作廢提案',
  'group.proposal.withdraw': '撤回提案',
  'group.proposal.withdraw_confirmation': '撤回確認',
  'group.set_open_to_join': '設定公開找組員',
  'group.type.change': '改組別類型',
  'advisor.assign': '指派指導老師',
  'advisor.reassign': '重派指導老師',
  'advisor.unassign': '解除指導老師',
  'advisor.claim': '認領產學組',
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
  // 專題事務與繳交（模組 04、05）
  'item.create': '建立專題事務',
  'item.save_draft': '儲存專題事務草稿',
  'item.publish': '發布專題事務',
  'item.update_published': '修改已發布的專題事務',
  'item.withdraw': '撤回專題事務',
  'submission.save_draft': '儲存繳交草稿',
  'submission.submit': '正式送出繳交',
  'submission.set_advisor_visibility': '設定指導老師閱覽',
  'submission.advisor_visibility.enable': '開放指導老師閱覽',
  'submission.advisor_visibility.disable': '關閉指導老師閱覽',
  // 評分（模組 06）
  'grading.scheme_create': '建立評分方案',
  'grading.scheme_publish': '發布評分方案',
  'grading.scheme_apply': '套用新評分方案',
  'grading.requirement_set': '設定評分份數',
  'grading.assign': '指派評分老師',
  'grading.assignment_remove': '移除評分老師',
  'grading.save_draft': '暫存評分',
  'grading.submit_final': '送出評分',
  'grading.return': '退回評分',
  'grading.override': '更正成績',
  'grading.override_resolve': '復核更正',
  'grading.override_review': '復核更正',
  'grading.export': '匯出成績',
  // 簽核與精選（模組 07、09）
  'signoff.version_create': '建立簽核版本',
  'signoff.version_reopen': '重開簽核',
  'signoff.version_reset': '重置簽核',
  'signoff.version_supersede': '簽核版本被取代',
  'signoff.version_void': '作廢簽核版本',
  'signoff.respond': '簽核表態',
  'signoff.remind': '提醒未同意者',
  'signoff.export': '匯出簽核',
  'showcase.draft_create': '建立精選草稿',
  'showcase.draft_update': '修改精選草稿',
  // 維運（模組 10）
  'ops.worker_alert': '背景工作警示',
}

/** 動作的中文；沒登記的動作照原代碼顯示（新功能忘了登記也不會讓頁面壞掉）。 */
export function auditActionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action
}

const TARGET_TYPE_LABEL: Record<string, string> = {
  user: '帳號',
  account_directory: '帳號名單',
  registration_application: '註冊申請',
  roster_version: '名單版本',
  cohort: '屆別',
  business_clock: '模擬時鐘',
  project_event: '活動',
  group: '組別',
  group_roster: '組別名單',
  group_proposal: '分組提案',
  industry_opportunity: '合作案',
  item: '專題事務',
  submission: '繳交',
  evaluation: '評分',
  gradebook: '成績表',
  grading_scheme_version: '評分方案',
  signoff_version: '簽核版本',
  showcase_entry: '精選',
  storage: '儲存空間',
}

export function auditTargetTypeLabel(targetType: string): string {
  return TARGET_TYPE_LABEL[targetType] ?? targetType
}

/** 對象那一欄的文字：「帳號・王小明」「組別・G03」；沒有名字就只寫類型。 */
export function describeAuditTarget(entry: Pick<AuditLogEntry, 'targetType' | 'targetName' | 'cohortCode'>): string {
  const type = auditTargetTypeLabel(entry.targetType)
  const name = entry.targetName?.trim()
  const cohort = entry.cohortCode && entry.targetType !== 'cohort' ? `（${entry.cohortCode}）` : ''
  return `${name ? `${type}・${name}` : type}${cohort}`
}
