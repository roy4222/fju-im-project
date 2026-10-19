import type { PublicGradingWeights } from '@/application/grading'
import { getCohortStatusQuery } from '@/composition/cohorts'
import { getPublicGradingQuery, ITEM_TYPE_LABEL } from '@/composition/grading'

/** 目前工作屆別已發布的評分方案；沒有工作屆別或還沒發布方案 → null（前台就不顯示這一段）。 */
export async function loadGradingWeights(): Promise<PublicGradingWeights | null> {
  const cohort = await getCohortStatusQuery().defaultWorking()
  if (!cohort) return null
  const result = await getPublicGradingQuery().weights(cohort.id)
  return result.ok ? result.receipt.weights : null
}

type Item = PublicGradingWeights['stages'][number]['items'][number]

/** 細項後綴：照系辦評分規則頁的寫法（`dashboard/admin/grading/rules/page.tsx`），前台沒有滿分欄。 */
function itemSuffix(item: Item): string {
  if (item.type === 'number') return `${item.weight}%`
  if (item.type === 'passfail') return `${ITEM_TYPE_LABEL[item.type]}・不計分`
  return `${item.weight}%・${ITEM_TYPE_LABEL[item.type]}`
}

/**
 * 前台 /rules「評分方式」（C 階段 C1-14、X7；設計方案① §7.5）：接在規則章節之後，
 * 內容讀自系辦評分規則（評分項目、占總成績比例、說明、細項），系辦發布新版後前台跟著變。
 * 不放進章節的 `<article>`（那裡是前台編輯標記的範圍），也不進「規則目錄」。
 */
export function GradingWeights({ weights }: { weights: PublicGradingWeights }) {
  return (
    <section aria-labelledby="grading-weights-title" className="flex flex-col gap-3" data-testid="grading-weights">
      <h2 id="grading-weights-title" className="border-b-2 border-border pb-2 text-[22px] font-bold text-ink">
        評分方式
      </h2>
      <p className="text-[15px] text-muted-foreground">{weights.cohortName}・依系辦目前發布的評分規則</p>
      <ul className="mt-1 flex flex-col gap-3">
        {weights.stages.map((stage, index) => (
          <li
            key={`${index}-${stage.name}`}
            aria-labelledby={`grading-stage-${index + 1}`}
            className="flex flex-col gap-2 rounded-[10px] bg-muted/60 p-4"
            data-testid="grading-stage"
          >
            <div className="flex items-baseline justify-between gap-3">
              <h3 id={`grading-stage-${index + 1}`} className="text-[17px] font-bold text-ink">
                {stage.name}
              </h3>
              <span className="shrink-0 text-[17px] font-bold tabular-nums text-primary" data-testid="grading-stage-weight">
                {stage.weight}%
              </span>
            </div>
            {stage.description ? <p className="text-[15px] leading-relaxed text-muted-foreground">{stage.description}</p> : null}
            <ul aria-label={`「${stage.name}」的細項`} className="flex flex-col gap-1 text-[15px]">
              {stage.items.map((item, i) => (
                <li key={`${i}-${item.name}`} className="flex justify-between gap-3 border-t border-border/60 pt-1 first:border-t-0 first:pt-0">
                  <span className="min-w-0 break-words">{item.name}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{itemSuffix(item)}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  )
}
