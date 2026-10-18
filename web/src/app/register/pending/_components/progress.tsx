import { IconCheck, IconX } from '@tabler/icons-react'
import { cn } from '@/shared/cn'

/**
 * 待審頁的三步進度（VB-5；visitor-r3 §3.5、AC-VI-51）：已送出 → 系辦審核中 → 已開通／被退回。
 * 待審時第 2 步是目前步驟（`aria-current="step"`）；被退回時第 3 步標「被退回」。
 * 已開通的人進不來這頁（`homeForUser` 已導走），所以沒有「已開通」打勾的狀態。
 */
type State = 'done' | 'current' | 'todo' | 'rejected'

export function ReviewProgress({ rejected }: { rejected: boolean }) {
  const steps: { label: string; note?: string; state: State }[] = [
    { label: '已送出', state: 'done' },
    { label: '系辦審核中', note: '通常 1～3 個工作天', state: rejected ? 'done' : 'current' },
    { label: rejected ? '被退回' : '已開通／被退回', note: '結果會寄到你的 Email', state: rejected ? 'rejected' : 'todo' },
  ]
  return (
    <ol className="flex flex-col" aria-label="審核進度" data-testid="review-progress">
      {steps.map((s, i) => (
        <li key={s.label} className="flex gap-3" aria-current={s.state === 'current' || s.state === 'rejected' ? 'step' : undefined} data-state={s.state}>
          <div className="flex flex-col items-center">
            <span
              className={cn(
                'flex size-7 shrink-0 items-center justify-center rounded-full text-[13px] font-bold',
                s.state === 'done' && 'bg-primary text-primary-foreground',
                s.state === 'current' && 'bg-primary-subtle text-primary-on-subtle ring-2 ring-primary',
                s.state === 'rejected' && 'bg-danger-subtle text-danger-on-subtle ring-2 ring-danger',
                s.state === 'todo' && 'bg-muted text-muted-foreground',
              )}
            >
              {s.state === 'done' ? (
                <IconCheck className="size-4" stroke={3} aria-hidden />
              ) : s.state === 'rejected' ? (
                <IconX className="size-4" stroke={3} aria-hidden />
              ) : (
                i + 1
              )}
            </span>
            {i < steps.length - 1 ? <span aria-hidden className={cn('my-1 w-0.5 flex-1', s.state === 'done' ? 'bg-primary' : 'bg-border')} /> : null}
          </div>
          <div className={cn('min-w-0 text-sm', i < steps.length - 1 ? 'pb-4' : '')}>
            <p className={cn(s.state === 'todo' ? 'text-muted-foreground' : 'font-bold text-foreground', s.state === 'rejected' && 'text-danger-on-subtle')}>
              {s.label}
              <span className="sr-only">
                {s.state === 'done' ? '（已完成）' : s.state === 'current' ? '（目前步驟）' : s.state === 'rejected' ? '（目前狀態）' : '（尚未開始）'}
              </span>
            </p>
            {s.note ? <p className="mt-0.5 text-[13px] text-muted-foreground">{s.note}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  )
}
