import type { ReactNode } from 'react'
import { TrackOnMount } from '@/app/_analytics/track-on-mount'
import { AuthSplit } from '@/app/_ui/auth-split'
import { SiteShell } from '@/app/_ui/site-shell'
import { StepBar } from './step-bar'

/** 左圖（實際尺寸 960×639，不是設計方案寫的 1600×1067）。 */
const CAMPUS = { src: '/placeholder/campus.jpg', alt: '輔仁大學校園', width: 960, height: 639 } as const

/**
 * 註冊三步共用的外框：站台頁首＋左圖右卡（≥1024px 兩欄、<1024px 只有卡片）＋進度條＋標題，
 * 載入時送一次 GA `register_step`（沒設 GA ID 時什麼都不送）。
 */
export function RegisterFrame({
  step,
  googleVerified = false,
  title,
  description,
  children,
}: {
  step: 1 | 2 | 3
  googleVerified?: boolean
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <SiteShell bare>
      <AuthSplit image={CAMPUS}>
        <TrackOnMount event="register_step" params={{ step }} />
        <StepBar current={step} googleVerified={googleVerified} />
        <div className="flex flex-col gap-5 rounded-xl border border-border bg-card p-6 sm:p-9">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-[26px] leading-tight font-extrabold text-foreground">{title}</h1>
            {description ? <div className="text-sm leading-relaxed text-muted-foreground">{description}</div> : null}
          </div>
          {children}
        </div>
      </AuthSplit>
    </SiteShell>
  )
}
