import { err, type Err } from '@/shared/result'
import {
  addTaipeiDays,
  formatTaipeiDate,
  isValidTaipeiDate,
  taipeiDayEndExclusive,
  taipeiDayStart,
  type TaipeiDate,
} from '@/shared/time'

/**
 * 階段模型的純規則（產品模組 02 §4「階段、活動與業務時間」，2026-09-12 定案 Q-PUB01）。
 *
 * - 每個階段只填開始日，開始日**嚴格遞增**；下一階段開始日的 00:00 起就不再屬於上一階段。
 * - 另填年度結束日，**含當天**，到隔天 00:00 才結束。
 * - 第一階段之前「尚未開始」，年度結束後「年度階段已結束」；不把最後階段無限延長，也不自動封存。
 * - 階段只看日期；每一組做完了沒是看實際紀錄，兩件事分開（進入期中≠已交期中報告）。
 *
 * 這個檔沒有資料庫：日期怎麼驗、今天落在哪一段，都在這裡單獨測。
 */

/** 票 11：管理員替屆別設四個階段（開發計畫票 11；年度劇本的四段只是測試資料，名稱由管理員填）。 */
export const STAGE_COUNT = 4
export const STAGE_NAME_MAX_LENGTH = 20

export type StageInput = { readonly name: string; readonly startDate: string }

export type ScheduleInput = {
  readonly stages: readonly StageInput[]
  readonly yearEndDate: string
}

export type Stage = {
  readonly seq: number
  readonly name: string
  readonly startDate: TaipeiDate
  /** 這一段的日期範圍每改一次 +1（契約 01 §4.7 的期限版本）。 */
  readonly deadlineVersion: number
}

export type CohortSchedule = {
  readonly stages: readonly Stage[]
  readonly yearEndDate: TaipeiDate | null
}

/** 整理並驗證「階段與年度結束日」的輸入。錯誤訊息指出是哪一段、哪一個日期。 */
export function normalizeScheduleInput(
  input: ScheduleInput,
): { ok: true; value: { stages: StageInput[]; yearEndDate: TaipeiDate } } | Err {
  if (input.stages.length !== STAGE_COUNT) {
    return err('VALIDATION_FAILED', `要剛好設定 ${STAGE_COUNT} 個階段。`)
  }

  const stages: StageInput[] = []
  for (const [index, raw] of input.stages.entries()) {
    const seq = index + 1
    const name = raw.name.trim()
    const startDate = raw.startDate.trim()
    if (!name) return err('VALIDATION_FAILED', `請填第 ${seq} 階段的名稱。`, { details: { field: `stage${seq}.name` } })
    if (name.length > STAGE_NAME_MAX_LENGTH) {
      return err('VALIDATION_FAILED', `第 ${seq} 階段的名稱最多 ${STAGE_NAME_MAX_LENGTH} 個字。`, {
        details: { field: `stage${seq}.name` },
      })
    }
    if (!isValidTaipeiDate(startDate)) {
      return err('VALIDATION_FAILED', `請填第 ${seq} 階段的開始日。`, { details: { field: `stage${seq}.startDate` } })
    }
    const previous = stages[index - 1]
    if (previous && startDate <= previous.startDate) {
      return err(
        'VALIDATION_FAILED',
        `第 ${seq} 階段的開始日（${formatTaipeiDate(startDate)}）要晚於第 ${seq - 1} 階段（${formatTaipeiDate(previous.startDate)}）。開始日必須一段比一段晚。`,
        { details: { field: `stage${seq}.startDate` } },
      )
    }
    stages.push({ name, startDate })
  }

  const yearEndDate = input.yearEndDate.trim()
  if (!isValidTaipeiDate(yearEndDate)) {
    return err('VALIDATION_FAILED', '請填年度結束日。', { details: { field: 'yearEndDate' } })
  }
  const last = stages.at(-1)!
  if (yearEndDate < last.startDate) {
    return err(
      'VALIDATION_FAILED',
      `年度結束日（${formatTaipeiDate(yearEndDate)}）不能早於最後一個階段的開始日（${formatTaipeiDate(last.startDate)}）。`,
      { details: { field: 'yearEndDate' } },
    )
  }

  return { ok: true, value: { stages, yearEndDate } }
}

/** 某一段的最後一天（含）：下一段開始日的前一天；最後一段到年度結束日。 */
export function stageLastDate(
  stages: readonly { startDate: TaipeiDate }[],
  yearEndDate: TaipeiDate,
  index: number,
): TaipeiDate {
  const next = stages[index + 1]
  return next ? addTaipeiDays(next.startDate, -1) : yearEndDate
}

export type StagePosition =
  /** 還沒設階段或年度結束日。 */
  | { readonly kind: 'unconfigured' }
  | { readonly kind: 'not_started'; readonly firstStartDate: TaipeiDate }
  | { readonly kind: 'in_stage'; readonly seq: number; readonly name: string; readonly lastDate: TaipeiDate }
  | { readonly kind: 'ended'; readonly yearEndDate: TaipeiDate }

/**
 * 這個業務時間落在哪一段（模組 02 §5 `StageQuery.currentStage`）。
 * 用半開區間判定：`start 00:00 <= t < 下一段 start 00:00`；年度結束日含當天。
 */
export function stagePositionAt(schedule: CohortSchedule, businessAt: Date): StagePosition {
  const { stages, yearEndDate } = schedule
  if (stages.length === 0 || !yearEndDate) return { kind: 'unconfigured' }

  const t = businessAt.getTime()
  const sorted = [...stages].sort((a, b) => a.seq - b.seq)
  if (t < taipeiDayStart(sorted[0]!.startDate).getTime()) {
    return { kind: 'not_started', firstStartDate: sorted[0]!.startDate }
  }
  if (t >= taipeiDayEndExclusive(yearEndDate).getTime()) return { kind: 'ended', yearEndDate }

  let index = 0
  for (const [i, stage] of sorted.entries()) {
    if (taipeiDayStart(stage.startDate).getTime() <= t) index = i
  }
  const current = sorted[index]!
  return {
    kind: 'in_stage',
    seq: current.seq,
    name: current.name,
    lastDate: stageLastDate(sorted, yearEndDate, index),
  }
}

/** 首頁的階段文字（S02-05 票：文案固定為「尚未開始／階段 n：名稱／年度階段已結束」）。 */
export function describeStagePosition(position: StagePosition): string {
  switch (position.kind) {
    case 'unconfigured':
      return '尚未設定階段'
    case 'not_started':
      return '尚未開始'
    case 'in_stage':
      return `階段 ${position.seq}：${position.name}`
    case 'ended':
      return '年度階段已結束'
  }
}

export type StagePlan = {
  readonly seq: number
  readonly name: string
  readonly startDate: TaipeiDate
  /** 新的期限版本；範圍沒變就沿用舊的。 */
  readonly deadlineVersion: number
  /** 這一段的日期範圍（開始日或最後一天）有沒有變。新段一律算變。 */
  readonly rangeChanged: boolean
  readonly isNew: boolean
}

/**
 * 比對新舊設定，算出每一段的新期限版本。
 *
 * 一段的範圍＝（開始日、最後一天）。改第 3 段的開始日，第 2 段的最後一天也跟著變，
 * 所以兩段都要 +1；只改名稱不動日期則版本不變。
 */
export function planStageVersions(
  current: CohortSchedule,
  next: { stages: readonly StageInput[]; yearEndDate: TaipeiDate },
): StagePlan[] {
  const oldBySeq = new Map(current.stages.map((stage) => [stage.seq, stage]))
  const oldSorted = [...current.stages].sort((a, b) => a.seq - b.seq)

  return next.stages.map((stage, index) => {
    const seq = index + 1
    const old = oldBySeq.get(seq)
    const newLast = stageLastDate(next.stages, next.yearEndDate, index)
    if (!old || !current.yearEndDate) {
      return {
        seq,
        name: stage.name,
        startDate: stage.startDate,
        deadlineVersion: old ? old.deadlineVersion + 1 : 1,
        rangeChanged: true,
        isNew: !old,
      }
    }
    const oldIndex = oldSorted.findIndex((s) => s.seq === seq)
    const oldLast = stageLastDate(oldSorted, current.yearEndDate, oldIndex)
    const rangeChanged = old.startDate !== stage.startDate || oldLast !== newLast
    return {
      seq,
      name: stage.name,
      startDate: stage.startDate,
      deadlineVersion: rangeChanged ? old.deadlineVersion + 1 : old.deadlineVersion,
      rangeChanged,
      isNew: false,
    }
  })
}

/**
 * 成組截止（票 13）：第 1 階段（成組期）結束的那一刻＝第 2 階段開始日的 00:00（臺灣時間）。
 *
 * 規格只寫「到期＝min(預設天數, 成組截止)」「成組截止來自 S02 階段」（工程確認 E-20：
 * 成組階段結束＝下一階段開始日）；四個階段的第 1 段就是成組期（年度主線與驗收劇本都這樣排）。
 * 還沒設階段回 null。
 */
export function groupingDeadline(schedule: CohortSchedule): Date | null {
  const sorted = [...schedule.stages].sort((a, b) => a.seq - b.seq)
  if (sorted.length === 0 || !schedule.yearEndDate) return null
  return taipeiDayEndExclusive(stageLastDate(sorted, schedule.yearEndDate, 0))
}
