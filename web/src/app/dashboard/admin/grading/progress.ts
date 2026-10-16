import type { AdminGradingBoard } from '@/application/grading'

/**
 * 系辦的老師評分進度：首頁與成績頁共用這一份算法（AC-AD-03、Q88），兩頁的數字才不會對不上。
 *
 * - 分母＝本屆**未解散組別**上、**已發布評分規則的階段**、指派給這位老師的評分份數；分子＝其中已正式送出的份數。
 * - 不傳 `stageKey`＝全部階段（Q115）；傳了只算那一階段。
 * - 解散：adminBoard 的 `groups` 只有進行中的組，指派的組不在裡面就是已解散——評分已停止，沒結束的指派也不算缺評。
 * - 目前版本沒有的階段（新版本拿掉的階段留下的舊指派）不算：成績頁的階段膠囊也看不到它們。
 * - 停用的老師照樣列出（不自動改派），由畫面標示。
 */
export type TeacherProgress = {
  readonly userId: string
  readonly name: string
  readonly inactive: boolean
  readonly assigned: number
  readonly counted: number
}

export function teacherProgress(
  board: AdminGradingBoard,
  opts: { readonly stageKey?: string; readonly excludeDissolved: true },
): readonly TeacherProgress[] {
  const stageKeys = new Set(opts.stageKey !== undefined ? [opts.stageKey] : (board.current?.stages ?? []).map((s) => s.key))
  const activeGroupIds = new Set(board.groups.map((g) => g.id))
  const byTeacher = new Map<string, { userId: string; name: string; inactive: boolean; assigned: number; counted: number }>()
  for (const a of board.assignments) {
    if (!stageKeys.has(a.stageKey) || !activeGroupIds.has(a.groupId)) continue
    const t = byTeacher.get(a.teacherUserId) ?? { userId: a.teacherUserId, name: a.teacherName, inactive: a.teacherInactive, assigned: 0, counted: 0 }
    t.assigned += 1
    if (a.state === 'counted') t.counted += 1
    byTeacher.set(a.teacherUserId, t)
  }
  return [...byTeacher.values()].sort((x, y) => x.name.localeCompare(y.name, 'zh-Hant') || x.userId.localeCompare(y.userId))
}

/** 首頁「評分還差 N 份」：全部階段、排除解散組的 Σ（分母 − 分子）。 */
export function remainingCount(board: AdminGradingBoard): number {
  return teacherProgress(board, { excludeDissolved: true }).reduce((n, t) => n + (t.assigned - t.counted), 0)
}
