import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { IconChevronDown, IconSignature, IconUsersGroup } from '@tabler/icons-react'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { Donut, SegmentCells } from '@/app/_ui/dashboard/charts'
import { CohortPills, PageTitle, Panel, PanelEmpty, QuietState } from '@/app/_ui/dashboard/primitives'
import { StateBadge } from '@/app/dashboard/_signoff/version-view'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { NewVersionDialog } from '@/app/dashboard/admin/signoff/new-version-dialog'
import { CreateVersionForm, type GroupOption } from '@/app/dashboard/admin/signoff/signoff-forms'
import type { AdminGroupRow, SignoffPurpose, VersionSummary } from '@/application/signoff'
import { getCohortStatusQuery } from '@/composition/cohorts'
import { describeCause, getSignoffQuery, SIGNOFF_PURPOSES, VOTE_RESULT_LABEL } from '@/composition/signoff'
import { formatTaipeiMinute } from '@/shared/time'

export const metadata = { title: '簽核管理｜資管系專題平台' }

/**
 * 管理員「簽核管理」（票 25、26；原型 `/dashboard/admin/signoff`）。
 *
 * 外觀照原型（票 36）：標題右上「新增簽核」開對話框（裡面是原本的建立簽核版本表單：貼全文、選附件、
 * 參與者快照；最終文件授權從精選草稿凍結範圍），下面左「整體進度」圓環、右「各組進度」逐人小格。
 * 每組兩個用途目前那一版各一列（缺誰可展開、最後事件時間），點版本號進版本頁看全文與歷史，
 * 在那裡提醒、重置、重開、作廢、匯出（票 26）。系辦沒有任何「替人同意」的入口。
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
 * 一個用途目前那一版（原型「各組進度」的一列：逐人小格＋「缺 N 位」可展開＋版本狀態）。
 * 每格一位學生、右邊短格是主指導；資料和學生頁、老師頁是同一份進度。
 */
function PackageCell({ purpose, summary }: { purpose: string; summary: VersionSummary | null }) {
  if (!summary) {
    return (
      <div className="grid items-center gap-x-3 gap-y-1 py-1 md:grid-cols-[6.5rem_minmax(0,1fr)]">
        <span className="text-xs font-semibold text-muted-foreground">{purpose}</span>
        <span className="text-sm text-muted-foreground">尚未建立</span>
      </div>
    )
  }
  const cause = describeCause(summary.cause)
  const p = summary.progress
  const teacherTurn = summary.state === 'teacher_pending'
  const advisorTone = p.advisor.result ? (p.advisor.result === 'agree' ? 'bg-success' : CELL_TONE[p.advisor.result]) : 'bg-muted'
  return (
    <div className="grid items-center gap-x-3 gap-y-1.5 py-1 md:grid-cols-[6.5rem_minmax(0,1fr)_9rem_auto]" data-testid="package-cell">
      <span className="text-xs font-semibold text-muted-foreground">{purpose}</span>
      <SegmentCells
        label={`學生 ${p.agreed}／${p.total} 已同意，主指導${p.advisor.result === 'agree' ? '已' : '未'}同意`}
        cells={p.students.map((s) => (s.result ? CELL_TONE[s.result] : 'bg-muted'))}
        trailing={advisorTone}
      />
      <div className="min-w-0 text-sm">
        {p.missing.length > 0 ? (
          <details className="group" data-testid="missing-details">
            <summary
              className={`inline-flex h-8 cursor-pointer list-none items-center gap-1 rounded-lg px-2 font-semibold transition-colors hover:bg-accent [&::-webkit-details-marker]:hidden ${teacherTurn ? 'text-brand' : 'text-foreground'}`}
            >
              {teacherTurn ? `等 ${p.advisor.displayName}` : `缺 ${p.missing.length} 位`}
              <IconChevronDown className="size-4 transition-transform duration-150 group-open:rotate-180" aria-hidden />
            </summary>
            <p className="mt-1.5 mb-1 rounded-lg bg-muted/40 px-3 py-2.5 text-sm text-foreground">還沒表態：{p.missing.join('、')}</p>
          </details>
        ) : (
          <span className={`px-2 font-semibold ${summary.state === 'complete' ? 'text-success-on-subtle' : 'text-muted-foreground'}`}>
            {summary.state === 'complete' ? '完成' : '—'}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 md:justify-self-end">
        <Link
          href={`/dashboard/admin/signoff/${summary.versionId}`}
          className="tabular text-sm font-bold text-ink underline-offset-4 hover:underline"
        >
          v{summary.versionNo}
        </Link>
        <StateBadge state={summary.state} />
        <span className="tabular text-xs text-muted-foreground">
          {p.agreed}／{p.total}
        </span>
      </div>
      <p className="tabular text-xs text-muted-foreground md:col-span-3 md:col-start-2">
        {cause && summary.state === 'superseded' ? `${cause}，待建新版・` : null}
        {cause && summary.state === 'revision' ? `理由：${cause}・` : null}
        最後事件 {formatTaipeiMinute(summary.lastEventAt)}
        {p.students.length > 0 ? (
          <span className="sr-only">
            ；逐人：{p.students.map((s) => `${s.displayName}${s.result ? VOTE_RESULT_LABEL[s.result] : '尚未表態'}`).join('、')}
          </span>
        ) : null}
      </p>
    </div>
  )
}

const COLUMN_LABEL: Record<SignoffPurpose, string> = { result_confirmation: '期中結果確認', final_document: '最終文件授權' }

export default async function AdminSignoffPage({ searchParams }: { searchParams: Promise<{ cohort?: string | string[] }> }) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole('/dashboard/admin/signoff', 'admin')

  const cohorts = (await getCohortStatusQuery().list()).filter((c) => c.status !== 'archived')
  const params = await searchParams
  const cohort = cohorts.find((c) => c.id === params.cohort) ?? cohorts.find((c) => c.isDefaultWorking) ?? cohorts[0] ?? null

  const shell = (children: React.ReactNode, title?: { description: string; actions?: React.ReactNode }) => (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/signoff">
      <div className="flex flex-col gap-5">
        <PageTitle
          title="簽核管理"
          description={title?.description ?? '系辦只能發布、重開或重置，不能代替任何人同意。'}
          actions={title?.actions}
        />
        {children}
      </div>
    </DashboardShell>
  )

  if (!cohort) {
    return shell(
      <QuietState
        title="還沒有屆別"
        hint="先到屆別頁新增一屆，才能建立那一屆的簽核。"
        action={
          <Link href="/dashboard/admin/cohorts" className="text-sm font-semibold text-primary hover:underline">
            前往屆別
          </Link>
        }
      />,
    )
  }

  const board = await getSignoffQuery().adminBoard(actor, cohort.id)
  if (!board.ok) return shell(<QuietState title="讀不到簽核資料" hint={board.message} />)
  const { groups } = board.receipt
  const summaries = groups.flatMap((g) => SIGNOFF_PURPOSES.map((p) => g.packages[p]).filter((s): s is VersionSummary => s !== null))
  const collecting = summaries.filter((s) => s.state === 'collecting').length
  const teacherPending = summaries.filter((s) => s.state === 'teacher_pending').length
  const needsAdmin = summaries.filter((s) => s.state === 'superseded' || s.state === 'revision').length
  const complete = summaries.filter((s) => s.state === 'complete').length
  const total = summaries.length
  const legend = [
    { name: '完成', value: complete, className: 'stroke-success', swatch: 'bg-success' },
    { name: '學生已齊、等老師', value: teacherPending, className: 'stroke-brand', swatch: 'bg-brand' },
    { name: '學生未齊', value: collecting, className: 'stroke-border', swatch: 'bg-border' },
    { name: '退回或失效', value: needsAdmin, className: 'stroke-destructive', swatch: 'bg-destructive' },
  ]

  return shell(
    <>
      <CohortPills cohorts={cohorts} currentId={cohort.id} hrefFor={(id) => `/dashboard/admin/signoff?cohort=${id}`} />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Panel title="整體進度" icon={<IconSignature />} description={`完成 ${complete}／${total} 個版本`} aria-label="整體進度">
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
            <ul className="flex flex-1 flex-col gap-2.5 text-sm" aria-label="各狀態版本數">
              {legend.map((l) => (
                <li key={l.name} className="flex items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-2">
                    <span className={`size-2.5 rounded-sm ${l.swatch}`} aria-hidden />
                    {l.name}
                  </span>
                  <b className="tabular">{l.value} 個</b>
                </li>
              ))}
              <li className="flex items-center justify-between gap-3 border-t border-border/70 pt-2 text-muted-foreground">
                <span title="各組兩個用途目前的版本">母數</span>
                <b className="tabular">{total} 個</b>
              </li>
            </ul>
          </div>
          <p className="border-t border-border/70 px-5 py-3 text-xs text-muted-foreground">
            提醒未同意者、重置或重開新版、作廢、匯出，都在點版本號進去的版本頁。系辦不能替任何人表態。
          </p>
        </Panel>

        <Panel title="各組進度" icon={<IconUsersGroup />} description="每格＝一位學生、右邊短格＝老師；點「缺 N 位」看是誰" aria-label="各組簽核">
          {groups.length === 0 ? (
            <PanelEmpty title="這一屆還沒有組別" hint="分組成立後才能建立簽核版本。" />
          ) : (
            <>
              {summaries.length === 0 ? (
                <p className="border-t border-border/70 px-5 py-3 text-sm text-muted-foreground">
                  尚未建立簽核：按右上「新增簽核」選一組、貼上全文，就能建立第一個簽核版本。
                </p>
              ) : null}
              <ul className="flex flex-col px-5 py-2">
                {groups.map((g) => (
                  <li key={g.groupId} className="border-b border-border/70 py-3 last:border-0" data-testid="signoff-group-row">
                    <div className="mb-1 flex flex-wrap items-baseline gap-x-3">
                      <span className="tabular text-sm font-bold">{g.groupCode}</span>
                      <span className="text-xs text-muted-foreground">
                        {g.members.length} 位學生＋{g.advisorName ?? '尚無主指導'}
                      </span>
                    </div>
                    <PackageCell purpose={COLUMN_LABEL.result_confirmation} summary={g.packages.result_confirmation} />
                    <PackageCell purpose={COLUMN_LABEL.final_document} summary={g.packages.final_document} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </Panel>
      </div>
    </>,
    {
      description: `${cohort.code}・${groups.length} 組、${total} 個目前版本。系辦只能發布、重開或重置，不能代替任何人同意。`,
      actions: (
        <NewVersionDialog>
          {groups.length === 0 ? (
            <QuietState title="這一屆還沒有組別" hint="分組成立後才能建立簽核版本。" />
          ) : (
            <CreateVersionForm groups={groups.map(toOption)} requestId={randomUUID()} />
          )}
        </NewVersionDialog>
      ),
    },
  )
}
