import type { ReactNode } from 'react'
import { TrackOnMount } from '@/app/_analytics/track-on-mount'
import { AuthStage } from '@/app/_ui/auth-stage'
import { SiteShell } from '@/app/_ui/site-shell'
import { StepBar, type StepDir } from './step-bar'

export { stepDir } from './step-bar'

/**
 * 註冊三步共用的外框：站台頁首＋置中白卡（背景 LetterGlitch 在 `register/layout.tsx`、沒有頁尾；規格④ §4.1）
 * ＋卡內進度條＋標題，載入時送一次 GA `register_step`（沒設 GA ID 時什麼都不送）。
 * `dir`：從哪個方向進來，步驟條照方向播（`back` 反向）。
 */
export function RegisterFrame({
  step,
  dir = 'forward',
  googleVerified = false,
  title,
  description,
  children,
}: {
  step: 1 | 2 | 3
  dir?: StepDir
  googleVerified?: boolean
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <SiteShell bare footer={false}>
      <AuthStage>
        <TrackOnMount event="register_step" params={{ step }} />
        <div className="flex flex-col gap-5 rounded-xl border border-border bg-card p-6 sm:p-9">
          <StepBar current={step} dir={dir} googleVerified={googleVerified} />
          <div className="flex flex-col gap-1.5">
            <h1 className="text-[26px] leading-tight font-extrabold text-foreground">{title}</h1>
            {description ? <div className="text-sm leading-relaxed text-muted-foreground">{description}</div> : null}
          </div>
          {children}
        </div>
      </AuthStage>
    </SiteShell>
  )
}
