import type {
  AssignEvaluatorReceipt,
  DraftReceipt,
  FinalReceipt,
  RequirementReceipt,
  SchemeVersionReceipt,
} from '@/application/grading/ports'

/** 各個評分動作成功後給使用者看的一句話（畫面經 composition 取用）。 */

export function describeSchemeVersionReceipt(r: SchemeVersionReceipt): string {
  return r.status === 'draft'
    ? `已建立方案 v${r.versionNo}（草稿）；按「發布」後老師才會用這一版。`
    : `方案 v${r.versionNo} 已發布，老師評分用這一版。`
}

export function describeRequirementReceipt(r: RequirementReceipt): string {
  return r.requiredCount === 0
    ? `${r.groupCode}「${r.stageName}」設為不需要評分。`
    : `${r.groupCode}「${r.stageName}」要 ${r.requiredCount} 份評分。`
}

export function describeAssignEvaluatorReceipt(r: AssignEvaluatorReceipt): string {
  return `已指派 ${r.teacherName} 老師評 ${r.groupCode}「${r.stageName}」；老師已收到通知。`
}

export function describeDraftReceipt(r: DraftReceipt): string {
  return `已暫存（填了 ${r.filled}／${r.total} 項）。暫存只有你和系辦看得到，不算正式分數。`
}

export function describeFinalReceipt(r: FinalReceipt): string {
  return `${r.groupCode}「${r.stageName}」已正式送出：${r.teacherScore} 分，已鎖定。`
}
