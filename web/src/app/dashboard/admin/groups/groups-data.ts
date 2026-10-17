import type { ResolvedActor } from '@/application/accounts'
import type { GradingQuery } from '@/application/grading'
import type { GradingAssignmentSummary } from '@/application/groups'
import { getGradingQuery } from '@/composition/grading'

/**
 * 系辦分組頁讀評分指派用的 port（AD-14；AC-AD-13 用假物件計數）。
 *
 * 重派對話框要列「原指導老師在本組的評分指派」。以前逐組呼叫 `assignmentsFor()`（N+1，組越多句數越多）；
 * 現在整屆讀一次 `adminBoard()`，在這裡照組別與老師分好。
 */
export type GroupsGradingPorts = {
  readonly grading: Pick<GradingQuery, 'adminBoard'>
}

export function groupsGradingPorts(): GroupsGradingPorts {
  return { grading: getGradingQuery() }
}

type AdvisedGroup = { readonly id: string; readonly advisor: { readonly teacherUserId: string } | null }

/**
 * 有指導老師的每一組 → 那位老師在本組的有效評分指派（沒有指導老師的組不在 Map 裡）。
 * 結果和逐組 `assignmentsFor()`（`listForGroup`）相同：順序照讀到的順序（建立時間）、
 * 已計分顯示成 submitted、階段名照目前方案（方案沒有這個階段就顯示 key）。
 */
export async function loadAdvisorGrading(
  ports: GroupsGradingPorts,
  actor: ResolvedActor,
  cohortId: string,
  groups: readonly AdvisedGroup[],
): Promise<Map<string, GradingAssignmentSummary[]>> {
  const advisorOf = new Map(groups.flatMap((g) => (g.advisor ? [[g.id, g.advisor.teacherUserId] as const] : [])))
  const out = new Map<string, GradingAssignmentSummary[]>([...advisorOf.keys()].map((id) => [id, []]))
  if (advisorOf.size === 0) return out

  const result = await ports.grading.adminBoard(actor, cohortId)
  // 頁面已過系辦守衛、屆別來自清單，讀不到是異常；丟錯而不是把指派當成沒有（重派時會漏處理）。
  if (!result.ok) throw new Error(`分組頁讀評分指派失敗：${result.message}`)
  const board = result.receipt
  const stageName = new Map((board.current?.stages ?? []).map((s) => [s.key, s.name]))

  for (const a of board.assignments) {
    if (advisorOf.get(a.groupId) !== a.teacherUserId) continue
    out.get(a.groupId)!.push({
      id: a.id,
      stageName: stageName.get(a.stageKey) ?? a.stageKey,
      state: a.state === 'counted' ? 'submitted' : a.state,
    })
  }
  return out
}
