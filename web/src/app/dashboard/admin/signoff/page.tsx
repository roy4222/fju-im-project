import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { Card, DataTable, EmptyState, PageHeader, Tile } from '@/app/_ui/primitives'
import { StateBadge } from '@/app/dashboard/_signoff/version-view'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { CreateVersionForm, type GroupOption } from '@/app/dashboard/admin/signoff/signoff-forms'
import type { AdminGroupRow, SignoffPurpose, VersionSummary } from '@/application/signoff'
import { getCohortStatusQuery } from '@/composition/cohorts'
import { describeCause, getSignoffQuery, SIGNOFF_PURPOSES, VOTE_RESULT_LABEL } from '@/composition/signoff'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute } from '@/shared/time'

export const metadata = { title: '簽核管理｜資管系專題平台' }

/**
 * 管理員「簽核」（票 25；原型 `/dashboard/admin/signoff`）。
 *
 * 一頁兩件事：上面建立簽核版本（貼全文、選附件、參與者快照；最終文件授權從精選草稿凍結範圍），
 * 下面每組兩個用途目前那一版的狀態與逐人進度（缺誰可展開、最後事件時間），點進版本頁看全文與歷史，
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
  agree: 'bg-primary',
  disagree: 'bg-danger',
  return: 'bg-danger',
} as const

/**
 * 一格一個版本（原型「每格＝一位學生、右邊短格＝老師；點『缺 N 位』看是誰」）：
 * 版本號、狀態、逐人小格、缺誰（展開）、最後事件時間。資料和學生頁、老師頁是同一份進度。
 */
function PackageCell({ summary }: { summary: VersionSummary | null }) {
  if (!summary) return <span className="text-muted-foreground">尚未建立</span>
  const cause = describeCause(summary.cause)
  const p = summary.progress
  return (
    <div className="space-y-1.5" data-testid="package-cell">
      <span className="flex flex-wrap items-center gap-2">
        <Link href={`/dashboard/admin/signoff/${summary.versionId}`} className="font-medium text-primary underline-offset-2 hover:underline">
          v{summary.versionNo}
        </Link>
        <StateBadge state={summary.state} />
        {summary.state === 'superseded' && cause ? <span className="text-xs text-muted-foreground">{cause}，待建新版</span> : null}
        {summary.state === 'revision' && cause ? <span className="text-xs text-muted-foreground">理由：{cause}</span> : null}
      </span>
      <span className="flex items-center gap-1" aria-label={`學生 ${p.agreed}／${p.total} 已同意`}>
        {p.students.map((s) => (
          <span
            key={s.userId}
            title={`${s.displayName}：${s.result ? VOTE_RESULT_LABEL[s.result] : '尚未表態'}`}
            className={cn('size-3 rounded-sm', s.result ? CELL_TONE[s.result] : 'bg-muted')}
          />
        ))}
        <span
          title={`${p.advisor.displayName}（主指導）：${p.advisor.result ? VOTE_RESULT_LABEL[p.advisor.result] : '尚未表態'}`}
          className={cn('ml-1 h-3 w-1.5 rounded-sm', p.advisor.result ? CELL_TONE[p.advisor.result] : 'bg-muted')}
        />
        <span className="ml-2 text-xs tabular-nums text-muted-foreground">
          {p.agreed}／{p.total}
        </span>
      </span>
      {p.missing.length > 0 ? (
        <details className="text-xs" data-testid="missing-details">
          <summary className="cursor-pointer text-primary">缺 {p.missing.length} 位</summary>
          <p className="mt-1 text-muted-foreground">{p.missing.join('、')}</p>
        </details>
      ) : null}
      <span className="block text-xs text-muted-foreground">最後事件 {formatTaipeiMinute(summary.lastEventAt)}</span>
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

  const shell = (children: React.ReactNode) => (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/signoff">
      <PageHeader title="簽核" description="建立簽核版本：貼全文、選附件、拍下參與者；系辦不能代替任何人同意。" />
      {children}
    </DashboardShell>
  )

  if (!cohort) {
    return shell(
      <EmptyState title="還沒有屆別" description="先到屆別頁新增一屆，才能建立那一屆的簽核。" action={{ href: '/dashboard/admin/cohorts', label: '前往屆別' }} />,
    )
  }

  const board = await getSignoffQuery().adminBoard(actor, cohort.id)
  if (!board.ok) return shell(<EmptyState title="讀不到簽核資料" description={board.message} />)
  const { groups } = board.receipt
  const summaries = groups.flatMap((g) => SIGNOFF_PURPOSES.map((p) => g.packages[p]).filter((s): s is VersionSummary => s !== null))
  const collecting = summaries.filter((s) => s.state === 'collecting').length
  const teacherPending = summaries.filter((s) => s.state === 'teacher_pending').length
  const needsAdmin = summaries.filter((s) => s.state === 'superseded' || s.state === 'revision').length
  const complete = summaries.filter((s) => s.state === 'complete').length

  return shell(
    <>
      {cohorts.length > 1 ? (
        <nav aria-label="選擇屆別" className="mb-4 flex flex-wrap gap-2">
          {cohorts.map((c) => (
            <Link
              key={c.id}
              href={`/dashboard/admin/signoff?cohort=${c.id}`}
              aria-current={c.id === cohort.id ? 'page' : undefined}
              className={cn(
                'rounded-full border px-3 py-1 text-sm',
                c.id === cohort.id ? 'border-primary bg-primary-subtle text-primary-on-subtle' : 'border-border text-ink hover:bg-muted',
              )}
            >
              {c.code}
            </Link>
          ))}
        </nav>
      ) : null}

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="已完成" value={complete} hint={`共 ${summaries.length} 個目前版本`} />
        <Tile label="學生已齊、等老師" value={teacherPending} hint="版本數" />
        <Tile label="學生未齊" value={collecting} hint="版本數" />
        <Tile label="退回或失效" value={needsAdmin} hint="等系辦重開新版" />
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card title="建立簽核版本" description="同一組同一用途再建一版，舊版就失效、所有人重新同意。">
          {groups.length === 0 ? (
            <EmptyState
              title="這一屆還沒有組別"
              description="分組成立後才能建立簽核版本。"
              action={{ href: '/dashboard/admin/groups', label: '前往分組' }}
            />
          ) : (
            <CreateVersionForm groups={groups.map(toOption)} requestId={randomUUID()} />
          )}
        </Card>

        <section aria-label="各組簽核" className="space-y-3">
          <h2 className="text-base font-semibold text-ink">各組目前的版本</h2>
          {summaries.length === 0 ? (
            <EmptyState title="尚未建立簽核" description="在左邊選一組、貼上全文就能建立第一個簽核版本；建好後這裡會列出每組的狀態。" />
          ) : null}
          <DataTable
            columns={['組別', '參與者（此刻）', COLUMN_LABEL.result_confirmation, COLUMN_LABEL.final_document]}
            rows={groups.map((g) => [
              <span key="code" className="font-medium text-ink">
                {g.groupCode}
              </span>,
              <span key="people" className="text-xs text-muted-foreground">
                {g.members.length} 位學生＋{g.advisorName ?? '尚無主指導'}
              </span>,
              <PackageCell key="mid" summary={g.packages.result_confirmation} />,
              <PackageCell key="final" summary={g.packages.final_document} />,
            ])}
            empty="這一屆還沒有組別。"
          />
          <p className="text-xs text-muted-foreground">
            每格一位學生、右邊短格是主指導；點版本號進版本頁可以提醒未同意者、重置或重開新版、作廢、匯出可列印頁與 CSV。系辦不能替任何人表態。
          </p>
        </section>
      </div>
    </>,
  )
}
