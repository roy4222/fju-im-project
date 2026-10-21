import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * SEC-2（#786）：`src/app/**` 底下每個 `'use server'` 檔 export 的 Server Action，都要在碰用例或資料之前過守門。
 *
 * 每個 action 逐一登記成三類之一（沒登記的新 action、登記了卻已不存在的都會紅）：
 * ① `self`：action 開頭自己守門——`const actor = await currentActor()` 接 `if (!isAdmin(actor)) 拒絕`
 *    （同檔 `isAdmin`＝系辦角色＋`checkStatus(actor, 'business')`），或 `await frontEditActor()` 接 `if (!actor) 拒絕`。
 * ② `useCase`：交給用例守門——登記 action 會呼叫的每個用例方法（`getX().method`）與那個方法第一步的守門函式。
 *    action：第一個「不是取身分」的 await 必須是登記的用例呼叫，而且身分參數直接來自 `currentActor()`／`resolveActor()`／`headers()`；
 *    其他 composition 的讀寫（Query port、別的用例）只要沒登記就紅。
 *    用例：解析實作類別的原始碼，守門之前不能有 await 或 `this` 的方法呼叫（可往內追兩層 `this.#私有方法`），
 *    第一個守門呼叫必須是登記的函式，且緊接 `if (...) return`；守門函式本身必須在讀資料前呼叫 `statusGate`（可追三層）。
 * ③ `allow`：明確白名單＋理由（登入、註冊、忘記密碼、OTP 等不需登入的流程，及少數另有理由的例外）。
 *
 * 這是結構合約，只接受可直接核對的寫法；新的寫法要連同反例一起擴充，不要放寬既有規則。
 * SEC-1 的 `front-edit-actor.test.ts` 另外檢查前台編輯 action 的 business 守門形狀，兩份並存。
 */

const srcRoot = path.resolve(import.meta.dirname, '../../src')
const appDir = 'app'

type UseCase = { cls: string; guard: string }
type Entry =
  | { kind: 'self'; guard: 'isAdmin' | 'frontEditActor' }
  | { kind: 'useCase'; uses: string[] }
  | { kind: 'allow'; reason: string }
  | { kind: 'forward'; to: string[]; reason: string }
  | { kind: 'dispatch'; ops: Record<string, string> }

// ── 用例方法與它第一步的守門 ─────────────────────────────────────────────────
// key＝action 裡的寫法（`getX().method`；`const command = getX()` 再 `command.method` 也算同一個）。
const UC: Record<string, UseCase> = {}
function uc(getter: string, cls: string, guard: string, methods: string[]) {
  for (const m of methods) UC[`${getter}().${m}`] = { cls, guard }
}
uc('getSelfAccountCommand', 'BetterAuthSelfAccountCommand', 'signedIn', ['updateContact', 'startGoogleLink', 'setPassword', 'viewMine', 'changePassword'])
uc('getAvatarCommand', 'PgAvatarCommand', 'statusGate', ['avatarUploadTicket', 'updateAvatar'])
uc('getAvatarCommand', 'PgAvatarCommand', 'accountAdminDenied', ['resetAvatar'])
uc('getProfileCardCommand', 'PgProfileCardCommand', 'authorizeOwner', ['save'])
uc('getTeacherSetupCommand', 'PgTeacherSetupCommand', 'teacherSetupDenied', ['complete'])
uc('getRosterCommand', 'PgRosterCommand', 'rosterAccessDenied', ['startUpload', 'preview', 'importRoster'])
uc('getRegistrationCommand', 'PgRegistrationCommand', 'reviewAccessDenied', ['approve', 'reject', 'previewApproveMany', 'approveMany'])
uc('getRegistrationCommand', 'PgRegistrationCommand', 'ownApplicationDenied', ['reviseMine', 'viewMine'])
uc('getAccountDirectoryCommand', 'PgAccountDirectoryCommand', 'accountAdminDenied', [
  'successionOptions', 'disable', 'restore', 'previewDeidentify', 'deidentify', 'previewBulkDisable', 'bulkDisable', 'sendResetMail',
])
uc('getAccountCommand', 'PgAccountCommand', 'accountAdminDenied', [
  'createTeacher', 'lookupByEmail', 'issueTemporaryPassword', 'grantRole', 'revokeRole', 'repairOrphan', 'createMember',
])
uc('getProfileEditCommand', 'PgProfileEditCommand', 'accountAdminDenied', ['view', 'edit'])
uc('getItemCommand', 'PgItemCommand', 'authorizeAdmin', [
  'create', 'saveDraft', 'review', 'publish', 'updatePublished', 'changeStatus', 'delete', 'setPinned', 'moveRule', 'startUpload',
  'renameResourceCategory', 'reorderRules',
])
uc('getSubmissionCommand', 'PgSubmissionCommand', 'authorizeAdmin', ['reopen', 'setExempt'])
uc('getSubmissionCommand', 'PgSubmissionCommand', 'authorizeReceiver', ['saveDraft', 'submit'])
uc('getReminderCommand', 'PgReminders', 'authorizeAdmin', ['remindItem', 'remindOverdue', 'remindGrading'])
uc('getBusinessClockCommand', 'PgBusinessClock', 'authorizeAdmin', ['set'])
uc('getCohortCommand', 'PgCohortCommand', 'authorizeAdmin', [
  'create', 'activate', 'setDefaultWorking', 'setRegistrationOpen', 'archive', 'unarchive', 'setGroupingSettings',
])
uc('getFileAdminCommand', 'PgFileAdminCommand', 'statusGate', ['deleteUnreferenced'])
uc('getGradingCommand', 'PgGradingCommand', 'authorizeAdmin', ['createSchemeVersion', 'publishScheme', 'setRequirement', 'assign'])
uc('getGradingCommand', 'PgGradingCommand', 'authorizeTeacher', ['saveDraft', 'submitFinal'])
uc('getGradingStageSettingCommand', 'PgGradingStageSettingCommand', 'authorizeAdmin', ['setStageSetting'])
uc('getGradingStageSettingQuery', 'PgGradingStageSettingQuery', 'authorizeAdmin', ['stageSettings'])
uc('getGradingResultsCommand', 'PgGradingResultsCommand', 'authorizeAdmin', [
  'returnEvaluation', 'removeAssignment', 'override', 'resolveReview', 'applySchemeVersion',
])
uc('getGradingSettlementCommand', 'PgGradingSettlementCommand', 'authorizeAdmin', ['settleStage', 'releaseSettlement'])
uc('getGroupCommand', 'PgGroupCommand', 'authorizeAdmin', ['voidProposal'])
uc('getGroupCommand', 'PgGroupCommand', 'prepareGroupChange', ['addMember', 'removeMember', 'changeLeader', 'dissolveGroup'])
uc('getGroupCommand', 'PgGroupCommand', 'authorizeStudent', [
  'setOpenToJoin', 'propose', 'confirm', 'decline', 'withdrawConfirmation', 'withdrawProposal',
])
uc('getGroupQuery', 'PgGroupQuery', 'statusGate', ['lookupStudent'])
uc('getAdvisorCommand', 'PgAdvisorCommand', 'authorizeAdmin', ['assign', 'unassign', 'startBatchUpload', 'previewBatch', 'executeBatch'])
uc('getAdvisorCommand', 'PgAdvisorCommand', 'authorizeTeacher', ['claim'])
uc('getGroupImportCommand', 'PgGroupImportCommand', 'authorizeAdmin', ['startUpload', 'preview', 'execute'])
uc('getOpportunityCommand', 'PgOpportunityCommand', 'gate', [
  'create', 'update', 'publish', 'withdraw', 'delete', 'link', 'unlink', 'request', 'decline', 'changeGroupType',
])
uc('getTestNotificationCommand', 'PgTestNotificationCommand', 'authorizeAdmin', ['send'])
uc('getShowcaseCommand', 'PgShowcaseCommand', 'authorizeAdmin', [
  'createDraft', 'createBackfill', 'updateDraft', 'requestPosterUpload', 'publish', 'publishUpdate', 'setHomePosition', 'withdraw',
  'republish', 'setAward', 'delete',
])
uc('getShowcaseQuery', 'PgShowcaseQuery', 'authorizeAdmin', ['adminBoard'])
uc('getSignoffCommand', 'PgSignoffCommand', 'authorizeAdmin', ['createVersion', 'reset', 'reopen', 'voidVersion', 'remind'])
uc('getSignoffCommand', 'PgSignoffCommand', 'statusGate', ['respond'])
uc('getConsentPublishHook', 'PgConsentPublishHook', 'authorizeAdmin', ['createForGroup'])
uc('getTimelineCommand', 'PgTimelineCommand', 'authorizeAdmin', [
  'saveSchedule', 'createActivity', 'updateActivity', 'cancelActivity', 'deleteActivity', 'moveActivity',
])
uc('getInboxCommand', 'PgInbox', 'reader', ['open', 'markRead', 'markAllRead'])

/** 守門函式本身不呼叫 `statusGate`、但另有理由可以當守門的（逐一說明）。 */
const SESSION_GUARDS: Record<string, string> = {
  signedIn:
    'BetterAuthSelfAccountCommand 的本人 session 檢查：再讀帳號狀態，停用／去識別化一律當未登入；改聯絡資料、綁 Google、設密碼再接 activeOnly；' +
    '改密碼、看自己的 Email 驗證狀態刻意只要本人 session（必須改密、待審的人也要能用）。',
}

// ── 逐一登記 ────────────────────────────────────────────────────────────────
const use = (...uses: string[]): Entry => ({ kind: 'useCase', uses })
const self = (guard: 'isAdmin' | 'frontEditActor'): Entry => ({ kind: 'self', guard })
const allow = (reason: string): Entry => ({ kind: 'allow', reason })
const PUBLIC = '公開流程，不需登入：'

const ACC = 'dashboard/admin/accounts/actions.ts'
const AFF = 'dashboard/admin/affairs/actions.ts'
const AFF_ID = 'dashboard/admin/affairs/[id]/actions.ts'
const COH = 'dashboard/admin/cohorts/actions.ts'
const GRA = 'dashboard/admin/grading/actions.ts'
const GRP = 'dashboard/admin/groups/actions.ts'
const IMP = 'dashboard/admin/groups/import-actions.ts'
const SHO = 'dashboard/admin/showcase/actions.ts'
const SIG = 'dashboard/admin/signoff/actions.ts'
const TIM = 'dashboard/admin/timeline/actions.ts'
const TFE = 'dashboard/admin/timeline/front-edit/actions.ts'
const INB = 'dashboard/_inbox/actions.ts'
const IND = 'dashboard/_industry/actions.ts'
const IFE = 'dashboard/_industry/front-edit/actions.ts'
const STA = 'dashboard/student/affairs/actions.ts'
const STG = 'dashboard/student/groups/actions.ts'

const REGISTRY: Record<string, Entry> = {
  // 帳號（本人）
  'account/actions.ts#signOutAction': allow('只結束呼叫者自己的 session，不讀寫別人的資料；任何狀態（含停用、必須改密）都要能登出。'),
  'account/actions.ts#reconfirmAction': allow('同 signOutAction：登出自己再導回登入頁重新確認身分。'),
  'account/actions.ts#updateContactAction': use('getSelfAccountCommand().updateContact'),
  'account/actions.ts#linkGoogleAction': use('getSelfAccountCommand().startGoogleLink'),
  'account/actions.ts#setPasswordAction': use('getSelfAccountCommand().setPassword'),
  'account/actions.ts#sendAccountVerifyOtpAction': use('getSelfAccountCommand().viewMine'),
  'account/actions.ts#verifyAccountOtpAction': use('getSelfAccountCommand().viewMine'),
  'account/actions.ts#avatarUploadTicketAction': use('getAvatarCommand().avatarUploadTicket'),
  'account/actions.ts#updateAvatarAction': use('getAvatarCommand().updateAvatar'),
  'account/change-password/actions.ts#changePasswordAction': use('getSelfAccountCommand().changePassword'),
  'account/profile-card/actions.ts#saveProfileCardAction': use('getProfileCardCommand().save'),
  'account/setup/actions.ts#completeTeacherSetupAction': use('getTeacherSetupCommand().complete'),

  // 系辦：帳號
  [`${ACC}#startRosterUploadAction`]: use('getRosterCommand().startUpload'),
  [`${ACC}#previewRosterAction`]: use('getRosterCommand().preview'),
  [`${ACC}#importRosterAction`]: use('getRosterCommand().importRoster'),
  [`${ACC}#approveRegistrationAction`]: use('getRegistrationCommand().approve'),
  [`${ACC}#rejectRegistrationAction`]: use('getRegistrationCommand().reject'),
  [`${ACC}#previewBulkApproveAction`]: use('getRegistrationCommand().previewApproveMany'),
  [`${ACC}#bulkApproveAction`]: use('getRegistrationCommand().approveMany'),
  [`${ACC}#successionOptionsAction`]: use('getAccountDirectoryCommand().successionOptions'),
  [`${ACC}#disableAccountAction`]: use('getAccountDirectoryCommand().disable'),
  [`${ACC}#restoreAccountAction`]: use('getAccountDirectoryCommand().restore'),
  [`${ACC}#previewDeidentifyAction`]: use('getAccountDirectoryCommand().previewDeidentify'),
  [`${ACC}#deidentifyAccountAction`]: use('getAccountDirectoryCommand().deidentify'),
  [`${ACC}#previewBulkDisableAction`]: use('getAccountDirectoryCommand().previewBulkDisable'),
  [`${ACC}#bulkDisableAction`]: use('getAccountDirectoryCommand().bulkDisable'),
  [`${ACC}#createTeacherAction`]: use('getAccountCommand().createTeacher'),
  [`${ACC}#lookupAccountAction`]: use('getAccountCommand().lookupByEmail'),
  [`${ACC}#issueTemporaryPasswordAction`]: use('getAccountCommand().issueTemporaryPassword'),
  [`${ACC}#grantAdminAction`]: use('getAccountCommand().grantRole'),
  [`${ACC}#revokeAdminAction`]: use('getAccountCommand().revokeRole'),
  [`${ACC}#repairOrphanAction`]: use('getAccountCommand().repairOrphan'),
  [`${ACC}#resetAvatarAction`]: use('getAvatarCommand().resetAvatar'),
  'dashboard/admin/accounts/edit-actions.ts#profileEditViewAction': use('getProfileEditCommand().view'),
  'dashboard/admin/accounts/edit-actions.ts#editAccountAction': use('getProfileEditCommand().edit'),
  'dashboard/admin/accounts/member-actions.ts#createMemberAction': use('getAccountCommand().createMember'),
  'dashboard/admin/accounts/reset-mail-actions.ts#sendResetMailAction': use('getAccountDirectoryCommand().sendResetMail'),

  // 系辦：事務
  [`${AFF}#createItemAction`]: use('getItemCommand().create'),
  [`${AFF}#saveDraftAction`]: use('getItemCommand().saveDraft'),
  [`${AFF}#reviewItemAction`]: use('getItemCommand().review'),
  [`${AFF}#publishItemAction`]: use('getItemCommand().publish'),
  [`${AFF}#updatePublishedAction`]: use('getItemCommand().updatePublished'),
  [`${AFF}#changeItemStatusAction`]: use('getItemCommand().changeStatus'),
  [`${AFF}#deleteItemAction`]: use('getItemCommand().delete'),
  [`${AFF}#setPinnedAction`]: use('getItemCommand().setPinned'),
  [`${AFF}#moveRuleAction`]: use('getItemCommand().moveRule'),
  [`${AFF}#startItemUploadAction`]: use('getItemCommand().startUpload'),
  'dashboard/admin/affairs/front-edit-context-action.ts#frontEditContextAction': self('frontEditActor'),
  [`${AFF_ID}#reopenAction`]: use('getSubmissionCommand().reopen'),
  [`${AFF_ID}#setExemptAction`]: use('getSubmissionCommand().setExempt'),
  [`${AFF_ID}#remindItemAction`]: use('getReminderCommand().remindItem'),
  'dashboard/admin/affairs/rename-category-action.ts#renameResourceCategoryAction': use('getItemCommand().renameResourceCategory'),
  'dashboard/admin/affairs/rules-actions.ts#reorderRulesAction': use('getItemCommand().reorderRules'),
  'dashboard/admin/clock/actions.ts#setBusinessClockAction': use('getBusinessClockCommand().set'),

  // 系辦：屆別、檔案、評分
  [`${COH}#createCohortAction`]: use('getCohortCommand().create'),
  [`${COH}#setCohortFlagAction`]: use('getCohortCommand().setDefaultWorking', 'getCohortCommand().setRegistrationOpen'),
  [`${COH}#activateCohortAction`]: use('getCohortCommand().activate'),
  [`${COH}#setCohortStatusAction`]: use('getCohortCommand().archive', 'getCohortCommand().unarchive'),
  'dashboard/admin/files/files-actions.tsx#deleteFileAction': use('getFileAdminCommand().deleteUnreferenced'),
  [`${GRA}#createSchemeVersionAction`]: use('getGradingCommand().createSchemeVersion'),
  [`${GRA}#publishSchemeAction`]: use('getGradingCommand().publishScheme'),
  [`${GRA}#setRequirementAction`]: use('getGradingCommand().setRequirement'),
  [`${GRA}#assignEvaluatorAction`]: use('getGradingCommand().assign'),
  [`${GRA}#setStageSettingAction`]: use('getGradingStageSettingQuery().stageSettings', 'getGradingStageSettingCommand().setStageSetting'),
  [`${GRA}#returnEvaluationAction`]: use('getGradingResultsCommand().returnEvaluation'),
  [`${GRA}#removeAssignmentAction`]: use('getGradingResultsCommand().removeAssignment'),
  [`${GRA}#overrideAction`]: use('getGradingResultsCommand().override'),
  [`${GRA}#resolveReviewAction`]: use('getGradingResultsCommand().resolveReview'),
  [`${GRA}#applySchemeAction`]: use('getGradingResultsCommand().applySchemeVersion'),
  [`${GRA}#settleStageAction`]: use('getGradingSettlementCommand().settleStage'),
  [`${GRA}#releaseSettlementAction`]: use('getGradingSettlementCommand().releaseSettlement'),

  // 系辦：分組
  [`${GRP}#saveGroupingSettingsAction`]: use('getCohortCommand().setGroupingSettings'),
  [`${GRP}#voidProposalAction`]: use('getGroupCommand().voidProposal'),
  [`${GRP}#addMemberAction`]: use('getGroupCommand().addMember'),
  [`${GRP}#removeMemberAction`]: use('getGroupCommand().removeMember'),
  [`${GRP}#changeLeaderAction`]: use('getGroupCommand().changeLeader'),
  [`${GRP}#dissolveGroupAction`]: use('getGroupCommand().dissolveGroup'),
  [`${GRP}#unlinkGroupOpportunityAction`]: self('isAdmin'),
  [`${GRP}#assignAdvisorAction`]: use('getAdvisorCommand().assign'),
  [`${GRP}#unassignAdvisorAction`]: use('getAdvisorCommand().unassign'),
  [`${GRP}#startAdvisorUploadAction`]: use('getAdvisorCommand().startBatchUpload'),
  [`${GRP}#previewAdvisorBatchAction`]: use('getAdvisorCommand().previewBatch'),
  [`${GRP}#executeAdvisorBatchAction`]: use('getAdvisorCommand().executeBatch'),
  [`${GRP}#changeGroupTypeAdminAction`]: self('isAdmin'),
  [`${GRP}#linkOpportunityAction`]: self('isAdmin'),
  [`${GRP}#searchLinkOptionsAction`]: self('isAdmin'),
  [`${GRP}#loadGroupHistoryAction`]: self('isAdmin'),
  [`${IMP}#groupImportAction`]: { kind: 'dispatch', ops: { settings: 'settings', upload: 'startUpload', preview: 'preview', execute: 'execute' } },
  [`${IMP}#groupImportAction>settings`]: self('isAdmin'),
  [`${IMP}#groupImportAction>startUpload`]: use('getGroupImportCommand().startUpload'),
  [`${IMP}#groupImportAction>preview`]: use('getGroupImportCommand().preview'),
  [`${IMP}#groupImportAction>execute`]: use('getGroupImportCommand().execute'),
  'dashboard/admin/groups/unassigned/actions.ts#voidUnassignedProposalAction': use('getGroupCommand().voidProposal'),

  // 系辦：通知、催繳、成果展示、簽核、時間軸
  'dashboard/admin/inbox/actions.ts#sendTestNotificationAction': use('getTestNotificationCommand().send'),
  'dashboard/admin/remind-actions.ts#remindOverdueAction': use('getReminderCommand().remindOverdue'),
  'dashboard/admin/remind-actions.ts#remindGradingAction': use('getReminderCommand().remindGrading'),
  [`${SHO}#createDraftAction`]: use('getShowcaseCommand().createDraft'),
  [`${SHO}#createBackfillAction`]: use('getShowcaseCommand().createBackfill'),
  [`${SHO}#updateDraftAction`]: use('getShowcaseCommand().updateDraft'),
  [`${SHO}#requestPosterUploadAction`]: use('getShowcaseCommand().requestPosterUpload'),
  [`${SHO}#publishAction`]: use('getShowcaseCommand().publish'),
  [`${SHO}#publishUpdateAction`]: use('getShowcaseCommand().publishUpdate'),
  [`${SHO}#setHomePositionAction`]: use('getShowcaseCommand().setHomePosition'),
  [`${SHO}#withdrawAction`]: use('getShowcaseCommand().withdraw'),
  [`${SHO}#republishAction`]: use('getShowcaseCommand().republish'),
  [`${SHO}#setAwardAction`]: use('getShowcaseCommand().setAward'),
  [`${SHO}#deleteEntryAction`]: use('getShowcaseCommand().delete'),
  [`${SHO}#lifecycleAction`]: {
    kind: 'forward', to: ['publishAction', 'publishUpdateAction', 'withdrawAction', 'republishAction', 'deleteEntryAction'],
    reason: '依表單 intent 轉呼叫同檔已登記的 action（各自交給用例守門），本身不碰資料。',
  },
  [`${SHO}#saveEntryAction`]: use(
    'getShowcaseCommand().createDraft', 'getShowcaseCommand().createBackfill', 'getShowcaseCommand().updateDraft',
    'getShowcaseCommand().setAward', 'getShowcaseCommand().setHomePosition', 'getShowcaseCommand().publish',
    'getShowcaseCommand().publishUpdate', 'getShowcaseCommand().republish',
  ),
  [`${SHO}#saveHomeOrderAction`]: use('getShowcaseCommand().setHomePosition'),
  [`${SHO}#showcaseFeStateAction`]: use('getShowcaseQuery().adminBoard'),
  [`${SIG}#createVersionAction`]: use('getSignoffCommand().createVersion'),
  [`${SIG}#restartAction`]: use('getSignoffCommand().reopen', 'getSignoffCommand().reset'),
  [`${SIG}#voidAction`]: use('getSignoffCommand().voidVersion'),
  [`${SIG}#remindAction`]: use('getSignoffCommand().remind'),
  [`${SIG}#createPackageAction`]: use('getConsentPublishHook().createForGroup'),
  [`${TIM}#saveScheduleAction`]: use('getTimelineCommand().saveSchedule'),
  [`${TIM}#createActivityAction`]: use('getTimelineCommand().createActivity'),
  [`${TIM}#updateActivityAction`]: use('getTimelineCommand().updateActivity'),
  [`${TIM}#cancelActivityAction`]: use('getTimelineCommand().cancelActivity'),
  [`${TIM}#deleteActivityAction`]: use('getTimelineCommand().deleteActivity'),
  [`${TIM}#moveActivityAction`]: use('getTimelineCommand().moveActivity'),
  [`${TIM}#previewScheduleAction`]: self('isAdmin'),
  [`${TIM}#saveStageDatesAction`]: self('isAdmin'),
  [`${TFE}#activityFeContextAction`]: self('frontEditActor'),
  [`${TFE}#saveActivityFeAction`]: self('frontEditActor'),
  [`${TFE}#removeActivityFeAction`]: self('frontEditActor'),

  // 共用後台：通知匣、合作案、簽核表態
  [`${INB}#openNotificationAction`]: use('getInboxCommand().open'),
  [`${INB}#markReadAction`]: use('getInboxCommand().markRead'),
  [`${INB}#markAllReadAction`]: use('getInboxCommand().markAllRead'),
  [`${IND}#saveOpportunityAction`]: use('getOpportunityCommand().update', 'getOpportunityCommand().create'),
  [`${IND}#changeOpportunityStatusAction`]: use('getOpportunityCommand().publish', 'getOpportunityCommand().withdraw'),
  [`${IND}#unlinkOpportunityAction`]: use('getOpportunityCommand().unlink'),
  [`${IND}#deleteOpportunityAction`]: use('getOpportunityCommand().delete'),
  [`${IFE}#opportunityFeContextAction`]: self('frontEditActor'),
  [`${IFE}#saveOpportunityFeAction`]: self('frontEditActor'),
  [`${IFE}#removeOpportunityFeAction`]: self('frontEditActor'),
  'dashboard/_signoff/actions.ts#respondAction': use('getSignoffCommand().respond'),

  // 學生、老師
  [`${STA}#saveDraftAction`]: use('getSubmissionCommand().saveDraft'),
  [`${STA}#submitAction`]: use('getSubmissionCommand().submit'),
  [`${STA}#requestUploadAction`]: allow(
    '經 composition 的 requestSubmissionUpload：守門前只在記憶體限速器記一次，key 是伺服器從 session 解出的 actor.userId' +
      '（未登入不記；別人無法冒用他人 id 消耗額度），不碰資料庫；之後交給 PgSubmissionCommand.requestUpload 的 authorizeReceiver。',
  ),
  [`${STG}#setOpenToJoinAction`]: use('getGroupCommand().setOpenToJoin'),
  [`${STG}#proposeAction`]: use('getGroupCommand().propose'),
  [`${STG}#lookupStudentAction`]: use('getGroupQuery().lookupStudent'),
  [`${STG}#requestOpportunityAction`]: use('getOpportunityCommand().request'),
  [`${STG}#confirmAction`]: use('getGroupCommand().confirm'),
  [`${STG}#terminateAction`]: use('getGroupCommand().decline', 'getGroupCommand().withdrawConfirmation', 'getGroupCommand().withdrawProposal'),
  'dashboard/teacher/grading/actions.ts#saveGradingDraftAction': use('getGradingCommand().saveDraft'),
  'dashboard/teacher/grading/actions.ts#submitGradingAction': use('getGradingCommand().submitFinal'),
  'dashboard/teacher/groups/actions.ts#claimGroupAction': use('getAdvisorCommand().claim'),
  'dashboard/teacher/groups/actions.ts#declineGroupAction': use('getOpportunityCommand().decline'),
  'dashboard/teacher/industry/link-action.ts#linkGroupAction': use('getOpportunityCommand().link'),

  // 前台編輯（SEC-1 另有更細的檢查）
  '_ui/front-edit/forms/actions.ts#saveSiteTextAction': self('frontEditActor'),
  '_ui/front-edit/forms/actions.ts#saveHeroAction': self('frontEditActor'),
  '_ui/front-edit/forms/actions.ts#requestHeroUploadAction': self('frontEditActor'),

  // 公開流程
  'login/actions.ts#signInAction': allow(`${PUBLIC}登入（Better Auth 驗密碼、限速、Turnstile）。`),
  'login/actions.ts#requestPasswordResetAction': allow(`${PUBLIC}忘記密碼寄信（不透露帳號是否存在；限速、Turnstile）。`),
  'login/actions.ts#googleSignInAction': allow(`${PUBLIC}開始 Google 登入（只產生導向網址）。`),
  'register/actions.ts#signUpStepAction': allow(`${PUBLIC}註冊第一步建帳號（註冊關閉時導回登入）。`),
  'register/actions.ts#backToSignupStep': allow(`${PUBLIC}註冊流程「回上一步」：只讀本人的申請（ownApplicationDenied）並登出自己的半成品 session。`),
  'register/actions.ts#reviseApplicationAction': allow(
    `${PUBLIC}註冊流程（待審的本人）：先用 session 解出的本人 userId 呼叫 homeForUser 看該去哪一頁（未驗證 Email 擋下），` +
      '只讀自己的角色、不回傳；之後交給 PgRegistrationCommand.reviseMine 的 ownApplicationDenied。',
  ),
  'register/apply/actions.ts#applyStepAction': allow(
    `${PUBLIC}註冊流程（待審的本人）：同 reviseApplicationAction，先 homeForUser 讀本人該去哪一頁，再交給 reviseMine 的 ownApplicationDenied。`,
  ),
  'register/verify/actions.ts#verifyOtpAction': allow(`${PUBLIC}註冊 Email 驗證碼（Better Auth 驗 OTP、限速）。`),
  'register/verify/actions.ts#resendOtpAction': allow(`${PUBLIC}重寄註冊驗證碼（限速）。`),
  'register/verify/actions.ts#resendResumeOtpAction': allow(`${PUBLIC}從續填 cookie 重寄註冊驗證碼（限速）。`),
  'reset-password/actions.ts#resetPasswordAction': allow(`${PUBLIC}以重設信的一次性 token 設新密碼。`),
}

// ── 解析 ────────────────────────────────────────────────────────────────────
type Fn = ts.FunctionLikeDeclaration & { body?: ts.ConciseBody }
type Action = { file: string; name: string; body?: ts.Block; node?: ts.Node }
type ImportRef = { module: string; name: string }
const key = (a: { file: string; name: string }) => `${a.file}#${a.name}`

function walk(node: ts.Node, visit: (node: ts.Node) => boolean | void) {
  if (visit(node) === false) return
  ts.forEachChild(node, (child) => walk(child, visit))
}
const isFunctionLike = (n: ts.Node) => ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)
function serverDirective(node: ts.SourceFile | ts.Block) {
  return node.statements.some((s) => ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression) && s.expression.text === 'use server')
}
function exported(node: ts.Node) {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
}

class Sources {
  private cache = new Map<string, ts.SourceFile>()
  constructor(readonly overrides: Record<string, string> = {}) {}
  has(file: string) {
    return file in this.overrides || existsSync(path.join(srcRoot, file))
  }
  read(file: string) {
    if (!this.cache.has(file)) {
      const text = this.overrides[file] ?? readFileSync(path.join(srcRoot, file), 'utf8')
      this.cache.set(file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true))
    }
    return this.cache.get(file)!
  }
  resolve(from: string, module: string): string | null {
    const base = module.startsWith('@/') ? module.slice(2) : module.startsWith('.') ? path.join(path.dirname(from), module) : null
    if (!base) return null
    return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base].find((f) => /\.tsx?$/.test(f) && this.has(f)) ?? null
  }
  imports(file: string) {
    const refs = new Map<string, ImportRef>()
    for (const s of this.read(file).statements) {
      if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue
      const clause = s.importClause
      if (!clause || clause.isTypeOnly) continue
      const bindings = clause.namedBindings
      if (bindings && ts.isNamedImports(bindings)) for (const e of bindings.elements) {
        if (!e.isTypeOnly) refs.set(e.name.text, { module: s.moduleSpecifier.text, name: (e.propertyName ?? e.name).text })
      }
    }
    return refs
  }
  /** 這個名字在檔內宣告的函式，或沿 import／re-export 找到的函式宣告。 */
  findFunction(file: string, name: string, depth = 0): { file: string; fn: Fn } | null {
    if (depth > 4) return null
    const source = this.read(file)
    for (const s of source.statements) {
      if (ts.isFunctionDeclaration(s) && s.name?.text === name && s.body) return { file, fn: s }
      if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer && ts.isArrowFunction(d.initializer)) return { file, fn: d.initializer }
      }
    }
    const ref = this.imports(file).get(name)
    if (ref) {
      const target = this.resolve(file, ref.module)
      return target ? this.findFunction(target, ref.name, depth + 1) : null
    }
    for (const s of source.statements) {
      if (!ts.isExportDeclaration(s) || s.isTypeOnly || !s.moduleSpecifier || !ts.isStringLiteral(s.moduleSpecifier)) continue
      const target = this.resolve(file, s.moduleSpecifier.text)
      if (!target) continue
      if (!s.exportClause) {
        const found = this.findFunction(target, name, depth + 1)
        if (found) return found
      } else if (ts.isNamedExports(s.exportClause)) {
        const entry = s.exportClause.elements.find((e) => e.name.text === name)
        if (entry) return this.findFunction(target, (entry.propertyName ?? entry.name).text, depth + 1)
      }
    }
    return null
  }
  private classIndex?: Map<string, { file: string; cls: ts.ClassDeclaration }>
  findClass(name: string) {
    if (!this.classIndex) {
      this.classIndex = new Map()
      for (const rel of readdirSync(path.join(srcRoot, 'infrastructure'), { recursive: true, encoding: 'utf8' })) {
        if (!/\.ts$/.test(rel) || /\.test\.ts$/.test(rel)) continue
        const file = path.join('infrastructure', rel)
        for (const s of this.read(file).statements) if (ts.isClassDeclaration(s) && s.name) this.classIndex.set(s.name.text, { file, cls: s })
      }
    }
    return this.classIndex.get(name) ?? null
  }

  /** `'use server'` 檔的 export；不認得的 export 寫法也列出來（沒有 body，一定判不過）。 */
  actions(file: string): Action[] {
    const source = this.read(file)
    if (!serverDirective(source)) return []
    const actions = new Map<string, Action>()
    for (const s of source.statements) {
      if (ts.isExportDeclaration(s)) {
        if (!s.isTypeOnly) actions.set(s.getText(), { file, name: s.getText() })
        continue
      }
      if (ts.isExportAssignment(s)) {
        actions.set('default', { file, name: 'default' })
        continue
      }
      if (!exported(s) || ts.isTypeAliasDeclaration(s) || ts.isInterfaceDeclaration(s)) continue
      if (ts.isFunctionDeclaration(s)) {
        const name = s.name?.text ?? 'default'
        // overload 宣告沒有 body；同名有 body 的那一個才是實作。
        if (s.body || !actions.has(name)) actions.set(name, { file, name, body: s.body, node: s })
      } else if (ts.isVariableStatement(s)) {
        for (const d of s.declarationList.declarations) {
          const v = d.initializer
          const body = v && (ts.isArrowFunction(v) || ts.isFunctionExpression(v)) && ts.isBlock(v.body) ? v.body : undefined
          actions.set(d.name.getText(), { file, name: d.name.getText(), body, node: d })
        }
      } else actions.set(s.getText(), { file, name: s.getText() })
    }
    return [...actions.values()]
  }
}

function discover(sources: Sources): Action[] {
  const files = readdirSync(path.join(srcRoot, appDir), { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => path.join(appDir, f))
  for (const f of Object.keys(sources.overrides)) if (f.startsWith(`${appDir}/`) && !files.includes(f)) files.push(f)
  return files.flatMap((f) => sources.actions(f)).map((a) => ({ ...a, file: a.file.slice(appDir.length + 1) }))
    .sort((a, b) => key(a).localeCompare(key(b)))
}

const appFile = (file: string) => path.join(appDir, file)

function isFailure(statement: ts.Statement | undefined, allowThrow: boolean): boolean {
  if (!statement) return false
  if (ts.isBlock(statement)) return statement.statements.length === 1 && isFailure(statement.statements[0], allowThrow)
  if (allowThrow && ts.isThrowStatement(statement)) return true
  if (!ts.isReturnStatement(statement) || !statement.expression) return false
  const v = statement.expression
  return ts.isObjectLiteralExpression(v) && v.properties.some((p) =>
    ts.isPropertyAssignment(p) && p.name.getText() === 'ok' && p.initializer.kind === ts.SyntaxKind.FalseKeyword)
}
function awaitedImport(node: ts.Expression | undefined, refs: Map<string, ImportRef>, module: string, name: string) {
  if (!node || !ts.isAwaitExpression(node) || !ts.isCallExpression(node.expression) || !ts.isIdentifier(node.expression.expression)) return false
  const ref = refs.get(node.expression.expression.text)
  return ref?.module === module && ref.name === name
}
function singleBinding(statement: ts.Statement | undefined) {
  if (!statement || !ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return null
  const d = statement.declarationList.declarations[0]!
  return ts.isIdentifier(d.name) ? { name: d.name.text, value: d.initializer } : null
}

/** ① action 開頭自己守門。 */
function selfGuarded(sources: Sources, action: Action, guard: 'isAdmin' | 'frontEditActor'): string | null {
  if (!action.body) return '沒有函式本體'
  const file = appFile(action.file)
  const refs = sources.imports(file)
  const [first, second] = action.body.statements
  const actor = singleBinding(first)
  if (guard === 'frontEditActor') {
    if (!actor || !awaitedImport(actor.value, refs, '@/app/_ui/front-edit/actor', 'frontEditActor')) return '第一句不是 const actor = await frontEditActor()'
    const ok = second && ts.isIfStatement(second) && ts.isPrefixUnaryExpression(second.expression)
      && second.expression.operator === ts.SyntaxKind.ExclamationToken && second.expression.operand.getText() === actor.name
      && isFailure(second.thenStatement, false)
    return ok ? null : '第二句不是 if (!actor) 拒絕'
  }
  if (!actor || !awaitedImport(actor.value, refs, '@/app/_ui/guard', 'currentActor')) return '第一句不是 const actor = await currentActor()'
  const call = second && ts.isIfStatement(second) && ts.isPrefixUnaryExpression(second.expression)
    && second.expression.operator === ts.SyntaxKind.ExclamationToken && second.expression.operand
  if (!call || !ts.isCallExpression(call) || call.expression.getText() !== 'isAdmin' || call.arguments[0]?.getText() !== actor.name
    || !isFailure((second as ts.IfStatement).thenStatement, true)) return '第二句不是 if (!isAdmin(actor)) 拒絕'
  const local = sources.read(file).statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'isAdmin')
  const ret = local?.body?.statements.length === 1 ? local.body.statements[0] : undefined
  const p = local?.parameters[0]?.name.getText()
  if (!ret || !ts.isReturnStatement(ret) || ret.expression?.getText().replace(/\s+/g, ' ') !== `actorHasRole(${p}, 'admin') && checkStatus(${p}, 'business') === null`) {
    return '同檔 isAdmin 不是「actorHasRole(actor, \'admin\') && checkStatus(actor, \'business\') === null」'
  }
  for (const name of ['actorHasRole', 'checkStatus']) if (refs.get(name)?.module !== '@/composition/accounts') return `${name} 不是從 @/composition/accounts 來的`
  return null
}

/** 身分參數：`await currentActor()`／`await resolveActor(...)`／`await headers()`，或綁定它們的變數。 */
function identityAwait(node: ts.Node, refs: Map<string, ImportRef>) {
  if (!ts.isAwaitExpression(node) || !ts.isCallExpression(node.expression) || !ts.isIdentifier(node.expression.expression)) return false
  const ref = refs.get(node.expression.expression.text)
  return !!ref && (ref.module === '@/app/_ui/guard' && ref.name === 'currentActor'
    || ref.module === '@/composition/accounts' && ref.name === 'resolveActor'
    || ref.module === 'next/headers' && (ref.name === 'headers' || ref.name === 'cookies'))
}

type PortCall = { use: string; call: ts.CallExpression; getterModule: string }
/** action 本體（含巢狀閉包）裡所有 composition getter 的方法呼叫，正規化成 `getX().method`。 */
function portCalls(body: ts.Block, refs: Map<string, ImportRef>): PortCall[] {
  const aliases = new Map<string, string>()
  walk(body, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isCallExpression(n.initializer)
      && ts.isIdentifier(n.initializer.expression) && n.initializer.arguments.length === 0) {
      const ref = refs.get(n.initializer.expression.text)
      if (ref?.module.startsWith('@/composition/')) aliases.set(n.name.text, n.initializer.expression.text)
    }
  })
  const calls: PortCall[] = []
  walk(body, (n) => {
    if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return
    const target = n.expression.expression
    let getter: string | undefined
    if (ts.isCallExpression(target) && ts.isIdentifier(target.expression) && target.arguments.length === 0) getter = target.expression.text
    else if (ts.isIdentifier(target)) getter = aliases.get(target.text)
    const ref = getter ? refs.get(getter) : undefined
    if (getter && ref?.module.startsWith('@/composition/')) calls.push({ use: `${ref.name}().${n.expression.name.text}`, call: n, getterModule: ref.module })
  })
  return calls
}

/** ② action 這一端：第一個非取身分的 await 是登記的用例；所有 composition 呼叫都登記過；身分直接來自 session。 */
function useCaseAction(sources: Sources, action: Action, uses: string[]): string | null {
  if (!action.body) return '沒有函式本體'
  const file = appFile(action.file)
  const refs = sources.imports(file)
  const calls = portCalls(action.body, refs)
  const extra = calls.filter((c) => !uses.includes(c.use)).map((c) => c.use)
  if (extra.length) return `呼叫了沒登記的 composition 方法：${[...new Set(extra)].join('、')}`
  const missing = uses.filter((u) => !calls.some((c) => c.use === u))
  if (missing.length) return `登記了但沒有呼叫：${missing.join('、')}`
  const identities = new Set<string>()
  walk(action.body, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && identityAwait(n.initializer, refs)) identities.add(n.name.text)
  })
  for (const c of calls) {
    const arg = c.call.arguments[0]
    if (!arg || !(identityAwait(arg, refs) || ts.isIdentifier(arg) && identities.has(arg.text))) {
      return `${c.use} 的第一個參數不是直接取自 currentActor()／resolveActor()／headers()`
    }
  }
  let first: ts.AwaitExpression | undefined
  walk(action.body, (n) => {
    if (first) return false
    if (n !== action.body && isFunctionLike(n)) return false
    if (ts.isAwaitExpression(n) && !identityAwait(n, refs)) first = n
  })
  // 沒有任何非取身分的 await（例如直接 `return getX().m(await currentActor())`）也可以：所有 composition 呼叫都已登記。
  if (first && !calls.some((c) => c.call === first!.expression)) {
    return `第一個非取身分的 await 不是登記的用例呼叫：${first.getText().slice(0, 80)}`
  }
  return null
}

/** 這個函式在讀資料前呼叫 `statusGate`（或另一個這樣的守門；最多三層）。 */
function isGuardFunction(sources: Sources, file: string, name: string, depth = 0): boolean {
  if (name === 'statusGate') return true
  if (depth > 3) return false
  const found = sources.findFunction(file, name)
  if (!found?.fn.body || !ts.isBlock(found.fn.body)) return false
  for (const s of found.fn.body.statements) {
    let hit = false
    let dirty = false
    walk(s, (n) => {
      if (ts.isAwaitExpression(n)) dirty = true
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && isGuardFunction(sources, found.file, n.expression.text, depth + 1)) hit = true
    })
    if (hit) return true
    if (dirty) return false
  }
  return false
}

function callsThis(n: ts.Node): ts.CallExpression | null {
  let found: ts.CallExpression | null = null
  walk(n, (c) => {
    if (found) return false
    if (ts.isCallExpression(c) && ts.isPropertyAccessExpression(c.expression) && c.expression.expression.kind === ts.SyntaxKind.ThisKeyword) found = c
  })
  return found
}

/** ② 用例這一端：守門前沒有 await／this 方法呼叫；第一個守門是登記的函式並緊接 if 早退（可追兩層 this 方法）。 */
function useCaseGuarded(sources: Sources, file: string, cls: ts.ClassDeclaration, method: string, guard: string, hops = 2): string | null {
  const member = cls.members.find((m): m is ts.MethodDeclaration =>
    ts.isMethodDeclaration(m) && m.name.getText() === method && !!m.body)
  if (!member?.body) return `${cls.name?.text}.${method} 找不到`
  const statements = member.body.statements
  for (let i = 0; i < statements.length; i++) {
    const s = statements[i]!
    const bound = singleBinding(s)
    const init = bound?.value && ts.isAwaitExpression(bound.value) ? bound.value.expression : bound?.value
    const isGuardCall = (n: ts.Node | undefined) => !!n && ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === guard
    // 形狀一：`const x = guard(actor)` 緊接 `if (...x...) { ...; return }`。形狀二：`if (guard(actor)) return`（可加 `!`）。
    const condition = ts.isIfStatement(s) ? (ts.isPrefixUnaryExpression(s.expression) ? s.expression.operand : s.expression) : undefined
    if (isGuardCall(init) || isGuardCall(condition)) {
      const branch = isGuardCall(init) ? statements[i + 1] : s
      if (!branch || !ts.isIfStatement(branch) || isGuardCall(init) && !branch.expression.getText().includes(bound!.name)
        || !ts.isReturnStatement(ts.isBlock(branch.thenStatement) ? branch.thenStatement.statements.at(-1) ?? branch.thenStatement : branch.thenStatement)) {
        return `${cls.name?.text}.${method} 呼叫 ${guard} 後沒有立刻 if 早退`
      }
      if (!SESSION_GUARDS[guard] && !isGuardFunction(sources, file, guard)) return `${guard} 沒有在讀資料前呼叫 statusGate`
      return null
    }
    const hop = callsThis(s)
    if (hop) {
      const name = (hop.expression as ts.PropertyAccessExpression).name.getText()
      if (hops > 0) return useCaseGuarded(sources, file, cls, name, guard, hops - 1)
      return `${cls.name?.text}.${method} 在守門前呼叫 this.${name}`
    }
    let awaits = false
    walk(s, (n) => {
      if (ts.isAwaitExpression(n)) awaits = true
    })
    if (awaits) return `${cls.name?.text}.${method} 在守門前有 await：${s.getText().slice(0, 80)}`
  }
  return `${cls.name?.text}.${method} 沒有呼叫 ${guard}`
}

function useCaseImpl(sources: Sources, use: string, getterModule: string): string | null {
  const entry = UC[use]
  if (!entry) return `${use} 沒有登記在用例表`
  const composition = sources.resolve('app/x.ts', getterModule)
  if (!composition || !sources.read(composition).text.includes(`new ${entry.cls}(`)) return `${getterModule} 沒有建立 ${entry.cls}`
  const found = sources.findClass(entry.cls)
  if (!found) return `找不到類別 ${entry.cls}`
  return useCaseGuarded(sources, found.file, found.cls, use.split('.').pop()!, entry.guard)
}

/** 找出 dispatch action 裡 op 對應的本地 helper，當成獨立的 action 檢查。 */
function dispatchHelpers(sources: Sources, action: Action, ops: Record<string, string>): { problem: string | null; helpers: Action[] } {
  const helpers: Action[] = []
  const sw = action.body?.statements.length === 1 ? action.body.statements[0] : undefined
  if (!sw || !ts.isSwitchStatement(sw)) return { problem: '本體不是單一 switch', helpers }
  const seen: Record<string, string> = {}
  for (const clause of sw.caseBlock.clauses) {
    const ret = clause.statements.length === 1 ? clause.statements[0] : undefined
    if (ts.isDefaultClause(clause)) {
      if (!isFailure(ret, false)) return { problem: 'default 不是拒絕', helpers }
      continue
    }
    const call = ret && ts.isReturnStatement(ret) && ret.expression && ts.isCallExpression(ret.expression) ? ret.expression : null
    if (!ts.isStringLiteral(clause.expression) || !call || !ts.isIdentifier(call.expression)) return { problem: 'case 不是 return helper(...)', helpers }
    seen[clause.expression.text] = call.expression.text
  }
  if (JSON.stringify(seen) !== JSON.stringify(ops)) return { problem: `op 對應不同：${JSON.stringify(seen)}`, helpers }
  const source = sources.read(appFile(action.file))
  for (const helper of Object.values(ops)) {
    const fn = source.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === helper)
    helpers.push({ file: action.file, name: `${action.name}>${helper}`, body: fn?.body })
  }
  return { problem: null, helpers }
}

function forwardOk(sources: Sources, action: Action, to: string[]): string | null {
  if (!action.body) return '沒有函式本體'
  const called = new Set<string>()
  let other: string | null = null
  walk(action.body, (n) => {
    if (ts.isAwaitExpression(n)) other = n.getText()
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) called.add(n.expression.text)
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.getText() !== 'formData.get') other = n.getText()
  })
  if (other) return `轉呼叫之外還做了別的事：${String(other).slice(0, 80)}`
  const exports = new Set(sources.actions(appFile(action.file)).map((a) => a.name))
  const bad = [...called].filter((c) => !to.includes(c) || !exports.has(c))
  return bad.length ? `轉呼叫了沒登記的函式：${bad.join('、')}` : null
}

/** 全部 action（含 dispatch helper）逐一判定；回傳 key → 問題（沒問題就不列）。 */
function violations(sources: Sources, registry: Record<string, Entry> = REGISTRY): Record<string, string> {
  const problems: Record<string, string> = {}
  const pending = discover(sources)
  const checked = new Set<string>()
  while (pending.length) {
    const action = pending.shift()!
    const k = key(action)
    checked.add(k)
    const entry = registry[k]
    let problem: string | null = null
    if (!entry) problem = '沒有登記守門（新 action 請登記在本測試頂端）'
    else if (entry.kind === 'self') problem = selfGuarded(sources, action, entry.guard)
    else if (entry.kind === 'allow') problem = entry.reason.trim().length < 10 ? '白名單沒寫理由' : null
    else if (entry.kind === 'forward') problem = entry.reason.trim() ? forwardOk(sources, action, entry.to) : '沒寫理由'
    else if (entry.kind === 'dispatch') {
      const result = dispatchHelpers(sources, action, entry.ops)
      problem = result.problem
      pending.push(...result.helpers)
    } else {
      problem = useCaseAction(sources, action, entry.uses)
      if (!problem && action.body) {
        const refs = sources.imports(appFile(action.file))
        for (const c of portCalls(action.body, refs)) problem ??= useCaseImpl(sources, c.use, c.getterModule)
      }
    }
    if (problem) problems[k] = problem
  }
  for (const k of Object.keys(registry)) if (!checked.has(k)) problems[k] = '登記了但已經沒有這個 action'
  return problems
}

// ── 測試 ────────────────────────────────────────────────────────────────────
const sources = new Sources()
const actions = discover(sources)
let baseline: Record<string, string> | undefined
const current = () => (baseline ??= violations(sources))

function mutate(file: string, from: string | RegExp, to: string): Sources {
  const text = sources.read(file).text
  const next = text.replace(from, to)
  if (next === text) throw new Error(`變造失敗：${file} 找不到 ${from}`)
  return new Sources({ [file]: next })
}

describe('SEC-2：每個 Server Action 都經守門', () => {
  it('盤點：src/app 的 use server 檔共 162 個 action（含 dispatch 子 op）全部登記', () => {
    const helpers = Object.keys(REGISTRY).filter((k) => k.includes('>')).length
    expect(actions.length + helpers).toBe(Object.keys(REGISTRY).length)
    expect(actions.length).toBe(162)
    for (const e of Object.values(REGISTRY)) if (e.kind === 'allow') expect(e.reason.length).toBeGreaterThan(10)
  })

  it('沒有任何 action 缺守門、守門在讀寫之後或登記過期', () => {
    expect(current()).toEqual({})
  })

  it.each(actions.map((a) => [key(a), REGISTRY[key(a)]?.kind ?? '未登記'] as const))('%s（%s）', (k) => {
    expect(current()[k]).toBeUndefined()
  })
})

describe('SEC-2：拿掉守門就紅（抽樣變造）', () => {
  it('① 時間軸 saveStageDatesAction 拿掉 isAdmin 早退（回到 SEC-2 修前：先讀 schedule）', () => {
    const file = appFile(TIM)
    const text = sources.read(file).text
    const start = text.indexOf('export async function saveStageDatesAction')
    const guard = '  if (!isAdmin(actor)) return { ok: false, message: STAGE_DATES_FORBIDDEN }\n'
    const at = text.indexOf(guard, start)
    const mutated = new Sources({ [file]: text.slice(0, at) + text.slice(at + guard.length) })
    expect(Object.keys(violations(mutated))).toEqual([`${TIM}#saveStageDatesAction`])
  })

  it('① 同檔 isAdmin 拿掉 business 狀態檢查（只看角色）', () => {
    const mutated = mutate(appFile(GRP), "return actorHasRole(actor, 'admin') && checkStatus(actor, 'business') === null", "return actorHasRole(actor, 'admin')")
    expect(Object.keys(violations(mutated)).sort()).toEqual(
      ['changeGroupTypeAdminAction', 'linkOpportunityAction', 'loadGroupHistoryAction', 'searchLinkOptionsAction', 'unlinkGroupOpportunityAction']
        .map((n) => `${GRP}#${n}`),
    )
  })

  it('① 匯入分組 settings helper 拿掉守門', () => {
    const mutated = mutate(appFile(IMP), "  if (!isAdmin(actor)) throw new Error('只有系辦可以匯入分組。')\n", '')
    expect(Object.keys(violations(mutated))).toEqual([`${IMP}#groupImportAction>settings`])
  })

  it('① 前台編輯 removeActivityFeAction 拿掉 frontEditActor 早退', () => {
    const file = appFile(TFE)
    const text = sources.read(file).text
    const start = text.indexOf('export async function removeActivityFeAction')
    const guard = "  if (!actor) return { ok: false, message: '只有系辦可以在前台編輯；請重新登入。' }\n"
    const at = text.indexOf(guard, start)
    const mutated = new Sources({ [file]: text.slice(0, at) + text.slice(at + guard.length) })
    expect(Object.keys(violations(mutated))).toEqual([`${TFE}#removeActivityFeAction`])
  })

  it('② 用例 PgCohortCommand.activate 拿掉 authorizeAdmin（action 端不變也要抓到）', () => {
    const file = 'infrastructure/cohorts/pg-cohorts.ts'
    const text = sources.read(file).text
    const start = text.indexOf('  async activate(')
    const from = text.indexOf('authorizeAdmin(', start)
    const mutated = new Sources({ [file]: text.slice(0, from) + 'Boolean(' + text.slice(from + 'authorizeAdmin('.length) })
    expect(Object.keys(violations(mutated))).toEqual([`${COH}#activateCohortAction`])
  })

  it('② 私有輔助裡的守門拿掉（prepareGroupChange 不再呼叫 authorizeAdmin）', () => {
    const file = 'infrastructure/groups/pg-groups.ts'
    const text = sources.read(file).text
    const start = text.indexOf('function prepareGroupChange(')
    const from = text.indexOf('authorizeAdmin(', start)
    const mutated = new Sources({ [file]: text.slice(0, from) + 'Boolean(' + text.slice(from + 'authorizeAdmin('.length) })
    expect(Object.keys(violations(mutated)).sort()).toEqual(
      ['addMemberAction', 'changeLeaderAction', 'dissolveGroupAction', 'removeMemberAction'].map((n) => `${GRP}#${n}`),
    )
  })

  it('② action 在用例前先讀 Query（沒登記的 composition 呼叫）', () => {
    const file = appFile('dashboard/admin/remind-actions.ts')
    const text = sources.read(file).text.replace("'use server'\n", "'use server'\nimport { getTimelineQuery } from '@/composition/cohorts'\n")
    const at = text.indexOf('{\n', text.indexOf('export async function remindOverdueAction(')) + 2
    const mutated = new Sources({ [file]: text.slice(0, at) + "  await getTimelineQuery().schedule('x')\n" + text.slice(at) })
    expect(violations(mutated)).toEqual({ 'dashboard/admin/remind-actions.ts#remindOverdueAction': expect.stringContaining('沒登記的 composition') })
  })

  it('② 身分不是來自 session（自己組 actor 傳給用例）', () => {
    const mutated = mutate(appFile('dashboard/admin/clock/actions.ts'), 'getBusinessClockCommand().set(await currentActor(),', 'getBusinessClockCommand().set({ kind: "anonymous" } as never,')
    expect(Object.keys(violations(mutated))).toEqual(['dashboard/admin/clock/actions.ts#setBusinessClockAction'])
  })

  it('③ 白名單拿掉一筆（公開的 resetPasswordAction 沒登記）就紅；白名單理由空白也紅', () => {
    const rest = Object.fromEntries(Object.entries(REGISTRY).filter(([k]) => k !== 'reset-password/actions.ts#resetPasswordAction'))
    expect(violations(sources, rest)).toEqual({ 'reset-password/actions.ts#resetPasswordAction': expect.stringContaining('沒有登記') })
    expect(violations(sources, { ...REGISTRY, 'login/actions.ts#signInAction': allow('') })).toEqual({
      'login/actions.ts#signInAction': '白名單沒寫理由',
    })
  })

  it('新的 use server 檔或新 export 沒登記就紅；不認得的 export 寫法不能略過', () => {
    const file = appFile('dashboard/admin/future/actions.ts')
    const mutated = new Sources({ [file]: `'use server'\nexport async function futureAction() { return { ok: true } }\nexport { other } from './x'\n` })
    expect(Object.keys(violations(mutated)).sort()).toEqual([
      "dashboard/admin/future/actions.ts#export { other } from './x'",
      'dashboard/admin/future/actions.ts#futureAction',
    ])
  })
})
