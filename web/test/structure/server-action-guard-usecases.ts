/**
 * SEC-2 的用例登記表（從 `server-action-guard.test.ts` 抽出，CL-7C）：用例方法 → 實作類別與它第一步的守門函式。
 * `server-action-guard.test.ts`（action 與用例的守門形狀）與 `server-action-guard-preguard.test.ts`（守門前不准發查詢）共用。
 */
export type UseCase = { cls: string; guard: string }
// ── 用例方法與它第一步的守門 ─────────────────────────────────────────────────
// key＝action 裡的寫法（`getX().method`；`const command = getX()` 再 `command.method` 也算同一個）。
export const UC: Record<string, UseCase> = {}
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
