import './step-bar.css'
import { IconCheck } from '@tabler/icons-react'
import { cn } from '@/shared/cn'

/**
 * 註冊三步的進度條（visitor-r3 §3.3；規格④ §4.3 Stepper B）。
 * 三格固定是「建立帳號／驗證 Email／填學生資料」；目前那一格 `aria-current="step"`、橘色放大，做完的打勾。
 * Server Component、0 JS：過場全在 `step-bar.css`；`dir="back"`（回上一步）時 `<ol data-anim="back">` 反向播。
 */
export type StepState = 'done' | 'current' | 'todo'

/** 從哪個方向進到這一步：`back` 是「回上一步」帶來的。 */
export type StepDir = 'forward' | 'back'

/** 網址的 `?dir=`：只認 `back`（「回上一步」帶來的），其他值都當往前。 */
export function stepDir(raw: string | string[] | undefined): StepDir {
  return raw === 'back' ? 'back' : 'forward'
}

export const STEP_LABELS = ['建立帳號', '驗證 Email', '填學生資料'] as const

/**
 * 第幾步（1～3）對應三格的狀態。`googleVerified`：Google 來的人 Email 已由 Google 證明，
 * 第 2 格直接打勾並註明「Google 已驗證」。
 */
export function stepStates(current: 1 | 2 | 3, googleVerified = false): { label: string; state: StepState; note?: string }[] {
  return STEP_LABELS.map((label, index) => {
    const n = index + 1
    const state: StepState = n < current ? 'done' : n === current ? 'current' : 'todo'
    return { label, state, ...(n === 2 && googleVerified && current > 2 ? { note: 'Google 已驗證' } : {}) }
  })
}

export function StepBar({
  current,
  dir = 'forward',
  googleVerified = false,
}: {
  current: 1 | 2 | 3
  dir?: StepDir
  googleVerified?: boolean
}) {
  const steps = stepStates(current, googleVerified)
  return (
    <ol className="step-bar flex items-start" aria-label="註冊進度" data-anim={dir === 'back' ? 'back' : undefined}>
      {steps.map((s, i) => {
        const done = s.state === 'done'
        const isCurrent = s.state === 'current'
        return (
          <li
            key={s.label}
            className="flex flex-1 flex-col items-center gap-2 text-center"
            aria-current={isCurrent ? 'step' : undefined}
            data-state={s.state}
          >
            <div className="flex w-full items-center">
              <span
                aria-hidden
                className={cn('h-0.5 flex-1', i === 0 ? 'invisible' : done || isCurrent ? 'step-line-on bg-primary' : 'bg-border')}
              />
              <span
                className={cn(
                  'step-dot flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-bold',
                  done
                    ? 'bg-primary text-primary-foreground'
                    : isCurrent
                      ? 'bg-primary text-primary-foreground ring-4 ring-primary/25'
                      : 'bg-muted text-muted-foreground',
                )}
              >
                {done ? <IconCheck className="size-4" stroke={3} aria-hidden /> : i + 1}
              </span>
              <span
                aria-hidden
                className={cn('h-0.5 flex-1', i === steps.length - 1 ? 'invisible' : done ? 'step-line-on bg-primary' : 'bg-border')}
              />
            </div>
            <span
              className={cn(
                'text-xs sm:text-[13px]',
                isCurrent ? 'font-bold text-foreground' : done ? 'font-semibold text-foreground' : 'text-muted-foreground',
              )}
            >
              {s.label}
              {s.note ? <span className="block text-[11px] font-normal text-muted-foreground">{s.note}</span> : null}
              <span className="sr-only">{done ? '（已完成）' : isCurrent ? '（目前步驟）' : '（尚未開始）'}</span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}
