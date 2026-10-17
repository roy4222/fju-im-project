import type { CohortGradingSnapshot } from '@/application/grading/ports'

/**
 * 從屆別評分快照推導系辦成績管理頁的數字（B 階段 TE-B6；設計方案 §4.2）。快照只讀一次，階段篩選在這裡做。
 * 老師評分進度卡片不在這裡：它跟首頁共用 `app/dashboard/admin/grading/progress.ts` 的 `teacherProgress()`（AC-AD-03），
 * 吃快照的 `board` 就好，兩頁的數字才不會對不上。
 */

export type StageProgressRow = {
  readonly key: string
  readonly name: string
  /** 已正式送出（採計中）的份數；每組以要求份數為上限。 */
  readonly done: number
  /** 需要的份數。 */
  readonly total: number
}

/**
 * 各階段完成率：已正式送出（採計中）的份數／需要的份數，從成績表同一份資料算。
 * - `stageKey` 是 null 或目前版本沒有這個階段＝全部階段（Q115），順序照目前版本。
 * - 解散的組評分已停止，不算；沒設要求份數、或用舊版本算而沒有這個階段的組也跳過。
 */
export function deriveStageRows(
  snapshot: Pick<CohortGradingSnapshot, 'board' | 'gradebook'>,
  stageKey: string | null,
): readonly StageProgressRow[] {
  const stages = snapshot.board.current?.stages ?? []
  const selected = stages.find((s) => s.key === stageKey)
  return (selected ? [selected] : stages).map((s) => {
    let done = 0
    let total = 0
    for (const g of snapshot.gradebook.groups) {
      if (g.dissolved) continue
      const r = g.result.stages.find((x) => x.key === s.key)
      if (!r || r.required === null) continue
      total += r.required
      done += Math.min(r.counted.length, r.required)
    }
    return { key: s.key, name: s.name, done, total }
  })
}
