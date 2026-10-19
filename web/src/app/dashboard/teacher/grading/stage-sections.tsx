import Link from 'next/link'
import type { TeacherQueueEntry } from '@/application/grading'
import { Pill } from '@/app/dashboard/teacher/_ui/dash'
import { filterQueue, gradingStatusOf } from '@/app/dashboard/teacher/grading/filter'
import type { GradingFilter } from '@/app/dashboard/teacher/grading/overview-types'
import { formatTaipeiMinute } from '@/shared/time'

/**
 * 老師評分清單的區段（C1-12，設計方案① §7.2、AC-27）：每個評分項目一個區段，底下每組一列——
 * 組別、狀態、附件（對應作業最後一次繳交的檔案數與日期；沒對應作業或還沒交寫「—」）、成績（已送出的分數）、「批改」。
 * 伺服器元件；篩選（`?filter=`）在伺服器端套到每個區段，區段標題的「已評 N／M 組」不受篩選影響。
 */

const BASE = '/dashboard/teacher/grading'

/** 台北時間的「m/d」（`2026/03/05 14:00` → `3/5`）。 */
function monthDay(at: Date): string {
  const [, m, d] = formatTaipeiMinute(at).slice(0, 10).split('/')
  return `${Number(m)}/${Number(d)}`
}

/** 附件欄：對應作業有正式繳交 → 「N 個檔案・m/d 交」；沒對應作業、或對應了還沒交 → 「—」。 */
export function attachmentText(linked: TeacherQueueEntry['linkedItem']): string {
  if (!linked || !linked.submitted || !linked.lastSubmittedAt) return '—'
  return `${linked.fileCount} 個檔案・${monthDay(linked.lastSubmittedAt)} 交`
}

function StatusCell({ e }: { e: TeacherQueueEntry }) {
  const status = gradingStatusOf(e)
  return (
    <span className="flex flex-wrap gap-1">
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
  )
}

const TH = 'px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground'
const TD = 'px-4 py-3 align-middle'

function StageSection({ stageKey, stageName, entries, filter }: { stageKey: string; stageName: string; entries: readonly TeacherQueueEntry[]; filter: GradingFilter }) {
  const list = filterQueue(entries, filter)
  const done = filterQueue(entries, 'submitted').length
  const headingId = `stage-${stageKey}-title`
  return (
    <section id={`stage-${stageKey}`} aria-labelledby={headingId} data-testid="stage-section" className="dash-card min-w-0 overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-5 py-3.5">
        <h2 id={headingId} className="text-[15px] font-bold text-foreground">
          {stageName}
        </h2>
        <p data-testid="grading-progress" className="tabular text-xs font-semibold text-muted-foreground">
          {`已評 ${done}／${entries.length} 組`}
        </p>
      </div>
      {list.length === 0 ? (
        <p className="border-t border-border px-5 py-8 text-center text-sm font-semibold text-muted-foreground">這個篩選沒有組別。</p>
      ) : (
        <div className="overflow-x-auto border-t border-border">
          <table aria-label={`${stageName}評分清單`} className="w-full min-w-[36rem] table-fixed text-sm">
            <thead className="bg-muted/40">
              <tr>
                <th scope="col" className={`${TH} w-[32%]`}>
                  組別
                </th>
                <th scope="col" className={`${TH} w-[24%]`}>
                  狀態
                </th>
                <th scope="col" className={`${TH} w-[20%]`}>
                  附件
                </th>
                <th scope="col" className={`${TH} w-[12%]`}>
                  成績
                </th>
                <th scope="col" className={TH}>
                  <span className="sr-only">動作</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {list.map((e) => {
                const submitted = gradingStatusOf(e) === 'submitted'
                return (
                  <tr key={e.assignmentId} data-testid="grading-entry">
                    <td className={TD}>
                      <span className="tabular font-bold text-foreground">{e.groupCode}</span>
                      {e.leaderName ? <span className="text-muted-foreground">{`・${e.leaderName}`}</span> : null}
                    </td>
                    <td className={TD}>
                      <StatusCell e={e} />
                    </td>
                    <td data-testid="entry-attachment" className={`${TD} tabular whitespace-nowrap text-muted-foreground`}>
                      {attachmentText(e.linkedItem)}
                    </td>
                    <td data-testid="entry-score" className={`${TD} tabular whitespace-nowrap`}>
                      {submitted && e.finalScore !== null ? <span className="font-extrabold text-foreground">{e.finalScore}</span> : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className={`${TD} text-right`}>
                      <Link
                        href={`${BASE}/${e.groupId}?stage=${encodeURIComponent(e.stageKey)}${filter === 'all' ? '' : `&filter=${filter}`}`}
                        aria-label={`批改：${e.groupCode}`}
                        className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-[13px] font-bold whitespace-nowrap text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring/40"
                      >
                        批改
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/** 依隊列順序分組：每個評分項目一個區段（項目順序照第一次出現的順序）。 */
export function StageSections({ entries, filter }: { entries: readonly TeacherQueueEntry[]; filter: GradingFilter }) {
  const stages: { key: string; name: string; entries: TeacherQueueEntry[] }[] = []
  for (const e of entries) {
    const stage = stages.find((s) => s.key === e.stageKey)
    if (stage) stage.entries.push(e)
    else stages.push({ key: e.stageKey, name: e.stageName, entries: [e] })
  }
  return (
    <div className="flex flex-col gap-5">
      {stages.map((s) => (
        <StageSection key={s.key} stageKey={s.key} stageName={s.name} entries={s.entries} filter={filter} />
      ))}
    </div>
  )
}
