import Link from 'next/link'
import { IconChecklist, IconFileAlert, IconSignature } from '@tabler/icons-react'
import { ListRow } from '@/app/dashboard/_home'
import { Panel, Pill } from '@/app/dashboard/teacher/_ui/dash'
import type { MissingGroup } from '@/app/dashboard/teacher/_home/missing'
import type { TeacherQueueEntry } from '@/application/grading'
import type { TeacherSignoffCard } from '@/application/signoff'
import { PURPOSE_LABEL } from '@/composition/signoff'

const BASE = '/dashboard/teacher'
/** 待評分卡最多列幾組；其餘寫「還有 N 組」連到評分頁。 */
const GRADING_ROWS = 5

/**
 * 老師首頁的待辦區（老師規格 §4.1 第 2 段；TE-07）：待評分、待我同意的同意書、缺件的組三張，每張列明細、每筆一個連結。
 *
 * 用老師自己的 `Panel`（共用 `TodoCard` 整張是連結、不收 children，裝不下每組一列）。0 筆的卡不顯示；
 * 三張都沒有就一句「目前沒有待辦」。「待辦」標題一律在（pages.spec 的直接打 HTTP 回歸測試用它當老師頁的指紋）。
 * 「繼續評分」整頁只有橫幅那一顆：這裡的連結文字直接是組號。
 */
export function TodoPanels({
  queue,
  ready,
  missing,
}: {
  queue: readonly TeacherQueueEntry[]
  /** 輪到我同意的同意書（`teacherSignoffSummary(...).ready`，一包一列）。 */
  ready: readonly TeacherSignoffCard[]
  missing: readonly MissingGroup[]
}) {
  const toGrade = queue.filter((e) => e.state !== 'counted')
  const empty = toGrade.length + ready.length + missing.length === 0

  return (
    <section aria-label="待辦" className="flex min-w-0 flex-col gap-3">
      <h2 className="text-[17px] font-extrabold tracking-tight text-foreground">待辦</h2>
      {empty ? (
        <p className="dash-card px-5 py-4 text-sm text-muted-foreground">目前沒有待辦</p>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-5 md:grid-cols-2 2xl:grid-cols-3">
          {toGrade.length > 0 ? (
            <Panel title="待評分" icon={<IconChecklist />} action={<Pill tone="brand">{toGrade.length} 組</Pill>} testId="todo-grading" className="h-full">
              <ul className="pb-2">
                {toGrade.slice(0, GRADING_ROWS).map((e) => (
                  <ListRow
                    key={e.assignmentId}
                    href={`${BASE}/grading/${e.groupId}?stage=${e.stageKey}`}
                    title={e.leaderName ? `${e.groupCode}・${e.leaderName}` : e.groupCode}
                    sub={`${e.stageName}・已填 ${e.filled}／${e.total} 項`}
                    trailing={e.returned ? <Pill tone="danger">系辦退回</Pill> : e.state === 'draft' ? <Pill tone="brand">草稿</Pill> : <Pill>未開始</Pill>}
                  />
                ))}
              </ul>
              {toGrade.length > GRADING_ROWS ? (
                <Link
                  href={`${BASE}/grading`}
                  className="block border-t border-border/70 px-5 py-3 text-[13px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
                >
                  還有 {toGrade.length - GRADING_ROWS} 組
                </Link>
              ) : null}
            </Panel>
          ) : null}

          {ready.length > 0 ? (
            // 單位「份」（D2 2026-10-16 定案）：一組可能同時有兩個簽核包，兩份都要去簽。
            <Panel title="待我同意的同意書" icon={<IconSignature />} action={<Pill tone="brand">{ready.length} 份</Pill>} testId="todo-signoff" className="h-full">
              <ul className="pb-2">
                {ready.map((c) => (
                  <ListRow
                    key={c.current.versionId}
                    href={`${BASE}/signoff/${c.current.versionId}`}
                    title={`${c.groupCode}・${PURPOSE_LABEL[c.purpose]}`}
                    sub="學生都同意了・輪到你"
                  />
                ))}
              </ul>
            </Panel>
          ) : null}

          {missing.length > 0 ? (
            <Panel title="缺件的組" icon={<IconFileAlert />} action={<Pill tone="danger">{missing.length} 組</Pill>} testId="todo-missing" className="h-full">
              <ul className="pb-2">
                {missing.map((g) => (
                  <ListRow key={g.groupId} href={`${BASE}/affairs`} title={`${g.code}・缺 ${g.titles.length} 份：${g.titles.join('、')}`} />
                ))}
              </ul>
            </Panel>
          ) : null}
        </div>
      )}
    </section>
  )
}
