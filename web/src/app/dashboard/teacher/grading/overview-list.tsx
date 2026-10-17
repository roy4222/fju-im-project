import Link from 'next/link'
import type { ReactNode } from 'react'
import { IconClock, IconFilter } from '@tabler/icons-react'
import type { TeacherQueueEntry } from '@/application/grading'
import { Pill } from '@/app/dashboard/teacher/_ui/dash'
import { filterQueue, gradingStatusOf } from '@/app/dashboard/teacher/grading/filter'
import type { GradingFilter, StageOption } from '@/app/dashboard/teacher/grading/overview-types'
import { cohortLabel } from '@/composition/cohorts'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute } from '@/shared/time'

/**
 * 評分總覽的清單（TE-06a，Q78；照原型 `teacher-grading.tsx` 的卡片格）：階段切換、四個篩選、每組一張卡。
 *
 * 伺服器元件：切階段（`?stage=`）與篩選（`?filter=`）都是 `<Link>`，在伺服器端過濾，沒有瀏覽器端 JS。
 * 單組頁左側的舊 `GradingQueue`／`QueueSelect` 不在這裡用（TE-06b 才移除）。
 * B 階段：正式送出後又存了草稿的卡加「有未送出修改」、系辦結算的階段加「已結算」（設計方案 §1.5、§2.5）。
 */

const FILTERS: readonly { key: GradingFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待評' },
  { key: 'draft', label: '草稿' },
  { key: 'submitted', label: '已送出' },
]

const BASE = '/dashboard/teacher/grading'

const PILL_LINK =
  'inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-sm font-bold transition-colors duration-150 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring/40'

/** 只有多個階段時網址才帶 `?stage=`；「全部」不帶 `?filter=`。 */
function hrefOf(stage: string | null, filter: GradingFilter): string {
  const q = new URLSearchParams()
  if (stage) q.set('stage', stage)
  if (filter !== 'all') q.set('filter', filter)
  const s = q.toString()
  return s ? `${BASE}?${s}` : BASE
}

function PillLink({ href, on, children }: { href: string; on: boolean; children: ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={on ? 'page' : undefined}
      className={cn(PILL_LINK, on ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground ring-1 ring-border hover:text-foreground')}
    >
      {children}
    </Link>
  )
}

function Card({ e }: { e: TeacherQueueEntry }) {
  const status = gradingStatusOf(e)
  const title = e.leaderName ? `${e.groupCode}・${e.leaderName}` : e.groupCode
  return (
    <Link
      href={`${BASE}/${e.groupId}?stage=${encodeURIComponent(e.stageKey)}`}
      data-testid="grading-card"
      className="dash-card dash-card-hover flex h-full flex-col gap-3 p-5 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring/40"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="tabular truncate text-[11px] text-muted-foreground">{cohortLabel({ name: e.cohortName, code: e.cohortCode })}</p>
          <h2 className="tabular mt-0.5 truncate text-[17px] leading-snug font-extrabold text-foreground">{title}</h2>
        </div>
        <span className="flex shrink-0 flex-wrap justify-end gap-1">
          {e.returned ? <Pill tone="danger">被退回</Pill> : null}
          {e.settled ? <Pill testId="card-settled">已結算</Pill> : null}
          {e.draftAfterFinal && !e.settled ? (
            <Pill tone="brand" testId="card-draft-after-final">
              有未送出修改
            </Pill>
          ) : null}
          {status === 'submitted' ? (
            <Pill tone="success">已送出</Pill>
          ) : status === 'draft' ? (
            <Pill tone="brand">{`草稿・已填 ${e.filled}／${e.total} 項`}</Pill>
          ) : (
            <Pill>待評</Pill>
          )}
        </span>
      </div>
      <div className="mt-auto flex flex-wrap items-end justify-between gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
        {status === 'submitted' && e.finalScore !== null ? (
          <span className="tabular whitespace-nowrap">
            <span className="text-[22px] leading-none font-extrabold text-foreground">{e.finalScore}</span> 分
          </span>
        ) : (
          <span>{status === 'draft' ? '繼續評分' : '開始評分'}</span>
        )}
        {status === 'submitted' && e.submittedAt ? (
          <span className="tabular inline-flex items-center gap-1 whitespace-nowrap text-xs">
            <IconClock className="size-3.5" aria-hidden />
            {`${formatTaipeiMinute(e.submittedAt)} 送出`}
          </span>
        ) : null}
      </div>
    </Link>
  )
}

export function GradingOverviewList({
  entries,
  stages,
  stageKey,
  filter,
}: {
  /** 這一階段的全部指派（還沒篩選）。 */
  entries: readonly TeacherQueueEntry[]
  /** 本人有指派的所有階段；只有一個時不顯示階段切換。 */
  stages: readonly StageOption[]
  stageKey: string
  filter: GradingFilter
}) {
  const multiStage = stages.length > 1
  const stageInUrl = multiStage ? stageKey : null
  const list = filterQueue(entries, filter)
  const empty = FILTERS.find((f) => f.key === filter)?.label ?? ''

  return (
    <div className="flex flex-col gap-4">
      {multiStage ? (
        <nav aria-label="階段" className="flex flex-wrap items-center gap-2">
          {stages.map((s) => (
            <PillLink key={s.key} href={hrefOf(s.key, 'all')} on={s.key === stageKey}>
              {s.name}
            </PillLink>
          ))}
        </nav>
      ) : null}

      <nav aria-label="篩選" className="flex flex-wrap items-center gap-2">
        <IconFilter className="size-4 text-muted-foreground" aria-hidden />
        {FILTERS.map((f) => (
          <PillLink key={f.key} href={hrefOf(stageInUrl, f.key)} on={f.key === filter}>
            {f.label}
            {/* 數量只給眼睛看；按鈕名稱維持「全部／待評／草稿／已送出」。 */}
            <span aria-hidden className="tabular text-xs opacity-80">
              {filterQueue(entries, f.key).length}
            </span>
          </PillLink>
        ))}
      </nav>

      {list.length === 0 ? (
        <p className="rounded-[18px] border border-dashed border-border bg-card/60 px-6 py-12 text-center text-sm font-semibold text-muted-foreground">
          {`沒有${empty}的組。`}
        </p>
      ) : (
        <ul aria-label="評分清單" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((e) => (
            <li key={e.assignmentId}>
              <Card e={e} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
