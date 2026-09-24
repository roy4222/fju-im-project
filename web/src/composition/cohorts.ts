import 'server-only'
import type { CohortCommand, CohortStatusQuery } from '@/application/cohorts'
import { getAuditWriter, getOperationLedger } from '@/composition/ops'
import { PgCohortCommand, PgCohortStatusQuery } from '@/infrastructure/cohorts/pg-cohorts'

/** 模組 02 屆別的實例組裝（票 5）。 */
let cohortCommand: CohortCommand | undefined
let cohortStatusQuery: CohortStatusQuery | undefined

export function getCohortCommand(): CohortCommand {
  cohortCommand ??= new PgCohortCommand({ audit: getAuditWriter(), ledger: getOperationLedger() })
  return cohortCommand
}

export function getCohortStatusQuery(): CohortStatusQuery {
  cohortStatusQuery ??= new PgCohortStatusQuery()
  return cohortStatusQuery
}

/** app 對 application 只能帶型別；畫面要用的標籤與回饋句子經這裡拿（母 spec §4.3）。 */
export {
  COHORT_CODE_MAX_LENGTH,
  COHORT_FLAG_LABEL,
  COHORT_NAME_MAX_LENGTH,
  COHORT_STATUS_LABEL,
  describeFlagReceipt,
} from '@/application/cohorts'
