/**
 * 模組 02 屆別與年度流程的公開入口（母 spec §4.3）。
 *
 * 跨模組只能從這裡引用，而且只能帶型別；執行期的實作由 composition 注入。
 */
export type {
  Cohort,
  CohortFlag,
  CohortStatus,
  CreateCohortInput,
  CreateCohortReceipt,
  SetCohortFlagReceipt,
} from '@/application/cohorts/cohorts'
export {
  canManageCohorts,
  COHORT_CODE_MAX_LENGTH,
  COHORT_FLAG_LABEL,
  COHORT_FLAGS,
  COHORT_NAME_MAX_LENGTH,
  COHORT_STATUS_LABEL,
  describeFlagReceipt,
  isCohortId,
  isRequestId,
  normalizeCreateInput,
} from '@/application/cohorts/cohorts'
export type { CohortCommand, CohortStatusQuery } from '@/application/cohorts/ports'
