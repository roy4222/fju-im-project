import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { IconSignature, IconUsersGroup } from '@tabler/icons-react'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { Donut, SegmentCells } from '@/app/_ui/dashboard/charts'
import { CohortPills, PageTitle, Panel, PanelEmpty, QuietState } from '@/app/_ui/dashboard/primitives'
import { StateBadge } from '@/app/dashboard/_signoff/version-view'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { NewVersionDialog } from '@/app/dashboard/admin/signoff/new-version-dialog'
import { CreateVersionForm, type GroupOption } from '@/app/dashboard/admin/signoff/signoff-forms'
import type { AdminGroupRow, SignoffPurpose, VersionSummary } from '@/application/signoff'
import { cohortLabel, getCohortStatusQuery } from '@/composition/cohorts'
import { describeCause, getSignoffQuery, SIGNOFF_PURPOSES, VOTE_RESULT_LABEL } from '@/composition/signoff'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute } from '@/shared/time'

export const metadata = { title: '同意書｜資管系專題平台' }

/**
 * 系辦「成績」側欄項的「同意書」分頁（AD-09；設計方案 §3.4；票 25、26）。
 *
 * 分頁列右側「新增站內同意書」開對話框（貼全文、選附件、參與者快照；最終文件授權從精選草稿凍結範圍）；
 * 下面用途篩選膠囊、左「整體進度」圓環、右「各組進度」每組一張卡（逐人小格、還沒回覆的人、版本與狀態）。
 * 點版本號進版本頁看全文與歷史，在那裡提醒、重新收集或重開、作廢、匯出（票 26）。系辦沒有任何「替人同意」的入口。
 */

function toOption(g: AdminGroupRow): GroupOption {
  return {
    groupId: g.groupId,
    groupCode: g.groupCode,
    members: g.members,
    advisorName: g.advisorName,
    showcase: g.showcase,
    submissionFiles: g.submissionFiles,
    currentVersionNo: {
      result_confirmation: g.packages.result_confirmation?.versionNo ?? null,
      final_document: g.packages.final_document?.versionNo ?? null,
    },
  }
}

const CELL_TONE = {
  // 原型：同意＝深藍格（原型的 primary）、老師同意＝綠。
  agree: 'bg-ink',
  disagree: 'bg-destructive',
  return: 'bg-destructive',
} as const

/**
 * 一組一張卡（AC-AD-19）：組別、版本與狀態、逐人小格、還沒回覆的人；第二行小字是最後事件時間與失效原因。
 * 每格一位學生、右邊短格是主指導；資料和學生頁、老師頁是同一份進度。
 */
function GroupCard({ code, summary }: { code: string; summary: VersionSummary | null }) {
  if (!summary) {
    return (
      <div className="flex flex-col gap-2">
        <span className="tabular text-sm font-bold">{code}</span>
        <SegmentCells label="尚未建立" cells={[]} trailing="bg-muted" />
        <span className="text-sm text-muted-foreground">尚未建立</span>
      </div>
    )
  }
  const cause = describeCause(summary.cause)
  const p = summary.progress
  const teacherTurn = summary.state === 'teacher_pending'
  const advisorTone = p.advisor.result ? (p.advisor.result === 'agree' ? 'bg-success' : CELL_TONE[p.advisor.result]) : 'bg-muted'
  return (
    <div className="flex flex-col gap-2" data-testid="package-cell">
      <div className="flex flex-wrap items-center gap-2">
        <span className="tabular text-sm font-bold">{code}</span>
        <Link
          href={`/dashboard/admin/signoff/${summary.versionId}`}
          className="tabular text-sm font-bold text-ink underline-offset-4 hover:underline"
        >
          第 {summary.versionNo} 版
        </Link>
        {/* 清單列的是目前版本：被取代就表示還沒有新版。 */}
        <StateBadge state={summary.state} cause={summary.cause} newerVersionNo={null} />
        <span className="tabular ml-auto text-xs text-muted-foreground">
          {p.agreed}／{p.total}
        </span>
      </div>
      <SegmentCells
        label={`學生 ${p.agreed}／${p.total} 已同意，指導老師${p.advisor.result === 'agree' ? '已' : '未'}同意`}
        cells={p.students.map((s) => (s.result ? CELL_TONE[s.result] : 'bg-muted'))}
        trailing={advisorTone}
      />
      {p.missing.length > 0 ? (
        <p className="text-sm text-foreground" data-testid="missing-details">
          <span className={`font-semibold ${teacherTurn ? 'text-brand' : ''}`}>{teacherTurn ? `等 ${p.advisor.displayName}` : `缺 ${p.missing.length} 位`}</span>
          <span className="text-muted-foreground">・還沒回覆：{p.missing.join('、')}</span>
        </p>
      ) : (
        <p className={`text-sm font-semibold ${summary.state === 'complete' ? 'text-success-on-subtle' : 'text-muted-foreground'}`}>
          {summary.state === 'complete' ? '完成' : '—'}
        </p>
      )}
      <p className="tabular text-xs text-muted-foreground">
        {cause && summary.state === 'superseded' ? `${cause}，待建新版・` : null}
        {cause && summary.state === 'revision' ? `理由：${cause}・` : null}
        最後動作 {formatTaipeiMinute(summary.lastEventAt)}
        {p.students.length > 0 ? (
          <span className="sr-only">
            ；逐人：{p.students.map((s) => `${s.displayName}${s.result ? VOTE_RESULT_LABEL[s.result] : '尚未回覆'}`).join('、')}
          </span>
        ) : null}
      </p>
    </div>
  )
}

const COLUMN_LABEL: Record<SignoffPurpose, string> = { result_confirmation: '期中結果確認', final_document: '最終文件授權' }

const BASE = '/dashboard/admin/signoff'

export default async function AdminSignoffPage({ searchParams }: { searchParams: Promise<{ cohort?: string | string[]; purpose?: string | string[] }> }) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole(BASE, 'admin')

  const cohorts = (await getCohortStatusQuery().list()).filter((c) => c.status !== 'archived')
  const params = await searchParams
  const cohort = cohorts.find((c) => c.id === params.cohort) ?? cohorts.find((c) => c.isDefaultWorking) ?? cohorts[0] ?? null
  const board = cohort ? await getSignoffQuery().adminBoard(actor, cohort.id) : null
  const groups = board?.ok ? board.receipt.groups : []

  // 「新增站內同意書」常駐在標題列右側（沒有屆別或讀不到資料時對話框裡說明原因）；pages.spec 指紋用這顆按鈕。
  const shell = (children: React.ReactNode) => (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current={BASE}>
      <div className="flex flex-col gap-5">
        <div>
          {/* 同意書不在「成績」分頁列上（C 階段規格② §2.2）；之後併進「作業」分頁，這頁再改成轉址。 */}
          <PageTitle
            title="成績"
            actions={
              <NewVersionDialog>
                {groups.length === 0 ? (
                  <QuietState title={cohort ? '這一屆還沒有組別' : '還沒有屆別'} hint={cohort ? '分組成立後才能建立站內同意書。' : '先到屆別頁新增一屆。'} />
                ) : (
                  <CreateVersionForm groups={groups.map(toOption)} requestId={randomUUID()} />
                )}
              </NewVersionDialog>
            }
          />
        </div>
        <p data-testid="tab-intro" className="-mt-2 mb-4 text-sm text-muted-foreground">
          站內同意書的版本與簽署進度；這一頁不在分頁列上，之後會併進「作業」分頁。
        </p>
        {cohort ? (
          <CohortPills cohorts={cohorts.map((c) => ({ id: c.id, code: cohortLabel(c) }))} currentId={cohort.id} hrefFor={(id) => `${BASE}?cohort=${id}`} />
        ) : null}
        {children}
      </div>
    </DashboardShell>
  )

  if (!cohort) {
    return shell(
      <QuietState
        title="還沒有屆別"
        hint="先到屆別頁新增一屆，才能建立那一屆的站內同意書。"
        action={
          <Link href="/dashboard/admin/cohorts" className="text-sm font-semibold text-primary hover:underline">
            前往屆別
          </Link>
        }
      />,
    )
  }

  if (!board?.ok) return shell(<QuietState title="讀不到站內同意書資料" hint={board?.message} />)
  // 每組有兩個用途（期中結果確認、最終文件授權），用篩選膠囊切換，一次看一個用途、一組一張卡。
  // 預設看第一個已經有版本的用途。
  const hasAny = (p: SignoffPurpose) => groups.some((g) => g.packages[p] !== null)
  const wanted = Array.isArray(params.purpose) ? params.purpose[0] : params.purpose
  const purpose: SignoffPurpose =
    SIGNOFF_PURPOSES.find((p) => p === wanted) ?? SIGNOFF_PURPOSES.find(hasAny) ?? SIGNOFF_PURPOSES[0]!
  const summaries = groups.map((g) => g.packages[purpose]).filter((s): s is VersionSummary => s !== null)
  const allVersions = groups.flatMap((g) => SIGNOFF_PURPOSES.map((p) => g.packages[p]).filter((s): s is VersionSummary => s !== null)).length
  const collecting = summaries.filter((s) => s.state === 'collecting').length
  const teacherPending = summaries.filter((s) => s.state === 'teacher_pending').length
  const needsAdmin = summaries.filter((s) => s.state === 'superseded' || s.state === 'revision' || s.state === 'void').length
  const complete = summaries.filter((s) => s.state === 'complete').length
  const notCreated = groups.length - summaries.length
  const total = groups.length
  const legend = [
    { name: '完成', value: complete, className: 'stroke-success', swatch: 'bg-success' },
    { name: '學生已齊、等老師', value: teacherPending, className: 'stroke-brand', swatch: 'bg-brand' },
    { name: '學生未齊', value: collecting, className: 'stroke-border', swatch: 'bg-border' },
    { name: '退回或作廢', value: needsAdmin, className: 'stroke-destructive', swatch: 'bg-destructive' },
    { name: '尚未建立', value: notCreated, className: 'stroke-muted', swatch: 'bg-muted' },
  ]
  const base = `${BASE}?cohort=${cohort.id}`

  return shell(
    <>
      <nav aria-label="選擇用途" className="flex flex-wrap items-center gap-2">
        {SIGNOFF_PURPOSES.map((p) => {
          const on = p === purpose
          return (
            <Link
              key={p}
              href={`${base}&purpose=${p}`}
              aria-current={on ? 'page' : undefined}
              className={cn(
                'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm font-semibold transition-colors',
                on ? 'border-ink bg-ink text-ink-foreground' : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {COLUMN_LABEL[p]}
              <span className={cn('tabular text-xs font-medium', on ? 'text-ink-foreground/80' : 'text-muted-foreground')}>
                {groups.filter((g) => g.packages[p] !== null).length}
              </span>
            </Link>
          )
        })}
      </nav>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Panel title="整體進度" icon={<IconSignature />} description={`${COLUMN_LABEL[purpose]}・完成 ${complete}／${total} 組`} aria-label="整體進度">
          <div className="flex flex-col gap-4 px-5 pt-1 pb-5 sm:flex-row sm:items-center sm:gap-6">
            <Donut
              size={150}
              thickness={20}
              data={legend}
              label={legend.map((l) => `${l.name} ${l.value}`).join('，')}
              center={
                <span className="text-center">
                  <span className="tabular block text-[26px] leading-none font-extrabold">
                    {total ? Math.round((complete / total) * 100) : 0}%
                  </span>
                  <span className="text-[10px] text-muted-foreground">完成</span>
                </span>
              }
            />
            <ul className="flex flex-1 flex-col gap-2.5 text-sm" aria-label="各狀態組數">
              {legend.map((l) => (
                <li key={l.name} className="flex items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-2">
                    <span className={`size-2.5 rounded-sm ${l.swatch}`} aria-hidden />
                    {l.name}
                  </span>
                  <b className="tabular">{l.value} 組</b>
                </li>
              ))}
              <li className="flex items-center justify-between gap-3 border-t border-border/70 pt-2 text-muted-foreground">
                <span>共</span>
                <b className="tabular">{total} 組</b>
              </li>
            </ul>
          </div>
        </Panel>

        <Panel title="各組進度" icon={<IconUsersGroup />} description={`${cohortLabel(cohort)}・${COLUMN_LABEL[purpose]}`} aria-label="各組同意書">
          {groups.length === 0 ? (
            <PanelEmpty title="這一屆還沒有組別" hint="分組成立後才能建立站內同意書。" />
          ) : (
            <>
              {allVersions === 0 ? (
                <p className="px-5 pb-3 text-sm text-muted-foreground">尚未建立同意書：按「新增站內同意書」選一組、貼上全文。</p>
              ) : null}
              <ul className="grid gap-3 px-5 pb-5 md:grid-cols-2">
                {groups.map((g) => (
                  <li
                    key={g.groupId}
                    className="rounded-lg border border-border p-4"
                    data-testid="signoff-group-row"
                    title={`${g.groupCode}：${g.members.length} 位學生＋${g.advisorName ?? '尚無指導老師'}`}
                  >
                    <GroupCard code={g.groupCode} summary={g.packages[purpose]} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </Panel>
      </div>
    </>,
  )
}
