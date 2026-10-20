import 'server-only'
import type { UnassignedQuery } from '@/application/groups'
import { PgUnassignedQuery } from '@/infrastructure/groups/pg-unassigned'

/**
 * 系辦「未分組學生」分頁的讀取（C3-15）。分組其他實例在 `groups.ts`；這張票不碰那檔，自己一個 getter。
 */
let unassignedQuery: UnassignedQuery | undefined

export function getUnassignedQuery(): UnassignedQuery {
  unassignedQuery ??= new PgUnassignedQuery()
  return unassignedQuery
}

export {
  describeUnassignedStatus,
  describeUnassignedVoid,
  skillChips,
  summarizeUnassigned,
  unassignedStatus,
} from '@/application/groups'
