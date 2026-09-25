/**
 * 模組 05 個人與組別繳交的公開入口（母 spec §4.3）。票 17：個人填報、存草稿、正式送出、自己的版本；
 * 票 18：收件名單三類、完成率、管理員看回答；票 21：組別共用草稿、上傳、代表全組送出、繳交附件的讀取規則；
 * 票 22：主指導的繳交矩陣與版本、被移出者的繳交紀錄（送出當下組員快照）、主指導閱覽開關。
 *
 * 跨模組只能從這裡引用，而且只能帶型別；執行期的實作由 composition 注入。
 */
export type {
  AnswerValue,
  Answers,
  FieldIssue,
  ItemStatusView,
  NormalizedAnswers,
  Phase,
  StatusFacts,
  StatusTone,
} from '@/application/submissions/submissions'
export {
  answerFields,
  describeIssues,
  describeReceipt,
  fileAnswers,
  isAnswerField,
  isFileField,
  LINE_MAX_LENGTH,
  MIB,
  normalizeAnswers,
  phaseOf,
  statusOf,
  submitIssues,
  TEXTAREA_MAX_LENGTH,
} from '@/application/submissions/submissions'
export type { Completion, ItemWindow, ReceiverFacts, RosterCategory } from '@/application/submissions/roster'
export { categoryOf, completionOf, overdueReceiverIds, pendingCount, receiverStatus } from '@/application/submissions/roster'
export type { AdvisorVisibility, SubmissionHolder, SubmissionViewer } from '@/application/submissions/access'
export { advisorMayReadIndividual, canReadSubmission } from '@/application/submissions/access'
export type {
  AdvisedGroup,
  AdvisorIndividualItem,
  AdvisorItemView,
  AdvisorMatrix,
  AdvisorMatrixCell,
  AdvisorMatrixItem,
  AdvisorReceiverView,
  AdvisorSubmissionQuery,
  GroupVersionEntry,
  AdvisorVisibilityView,
  AnswerFile,
  DraftReceipt,
  GroupSummary,
  ItemRoster,
  ReceiverDetail,
  RosterEntry,
  RosterItem,
  RosterQuery,
  RosterSpan,
  MyItemDetail,
  MyItemRow,
  MyRecordDetail,
  MyRecordRow,
  MyVersionDetail,
  SubmissionCommand,
  SubmissionFile,
  SubmissionQuery,
  SubmitReceipt,
  VersionSummary,
  VisibilityReceipt,
} from '@/application/submissions/ports'
