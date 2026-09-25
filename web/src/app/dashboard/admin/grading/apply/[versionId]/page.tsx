import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { Card, EmptyState } from '@/app/_ui/primitives'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { ApplySchemeForm } from '@/app/dashboard/admin/grading/results-forms'
import { getGradebookQuery } from '@/composition/grading'
import { cn } from '@/shared/cn'

export const metadata = { title: '套用新評分方案｜資管系專題平台' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 方案鎖定後套用新版本（票 24；產品 06 §4「7.5」「新版套用前顯示重算預覽與受影響組別，由管理員明確確認」、GRD-09）。
 *
 * 看影響只是讀：按「取消」什麼都不重算。確認時伺服器重新比對（預覽之後有人送分、退回或改份數就要重看），
 * 已正式送出的分數在新版本對不上（少了項目、滿分比已給的分數低…）就列出原因、不能套用。
 */
export default async function ApplySchemePage({ params }: { params: Promise<{ versionId: string }> }) {
  const { versionId } = await params
  const actor = await requireRole(`/dashboard/admin/grading/apply${UUID.test(versionId) ? `/${versionId}` : ''}`, 'admin')
  if (!UUID.test(versionId)) notFound()
  const preview = await getGradebookQuery().previewSchemeVersion(actor, versionId)

  const back = preview.ok ? `/dashboard/admin/grading?cohort=${preview.receipt.cohortId}` : '/dashboard/admin/grading'
  const shell = (children: React.ReactNode) => (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/grading">
      <Link href={back} className="mb-4 inline-flex text-sm font-medium text-muted-foreground hover:text-foreground">
        ← 評分
      </Link>
      <header className="mb-5">
        <h1 className="text-xl font-semibold text-foreground">套用新評分方案</h1>
      </header>
      {children}
    </DashboardShell>
  )

  if (!preview.ok) return shell(<EmptyState title="現在不能套用這個版本" description={preview.message} />)
  const p = preview.receipt
  const changed = p.groups.filter((g) => g.changed)

  return shell(
    <div className="space-y-6">
      <Card
        title={`v${p.currentVersionNo} → v${p.versionNo} 的影響`}
        description={`已正式送出的分數照 v${p.versionNo} 的滿分與權重重算；老師的原始輸入不會改。${changed.length} 組的成績會變。`}
      >
        {p.blockers.length > 0 ? (
          <div role="alert" className="mb-4 space-y-1 rounded-lg bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
            <p className="font-semibold">不能套用：</p>
            <ul className="list-disc pl-5">
              {p.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {p.groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">這一屆還沒有組別。</p>
        ) : (
          <div className="overflow-x-auto rounded-card border border-border">
            <table className="w-full min-w-[36rem] text-sm" aria-label="套用影響">
              <thead className="bg-muted text-left text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">組別</th>
                  {p.groups[0]!.stages.map((s) => (
                    <th key={s.name} className="px-4 py-2 text-right font-medium">
                      {s.name}
                    </th>
                  ))}
                  <th className="px-4 py-2 text-right font-medium">最終成績</th>
                </tr>
              </thead>
              <tbody>
                {p.groups.map((g) => (
                  <tr key={g.groupId} className={cn('border-t border-border', g.changed ? 'bg-primary-subtle/30' : '')} data-testid={`apply-row-${g.code}`}>
                    <td className="px-4 py-2 font-semibold">
                      {g.code}
                      {g.hasOverride ? <span className="ml-2 text-xs font-normal text-danger">更正會進待復核</span> : null}
                    </td>
                    {g.stages.map((s) => (
                      <td key={s.name} className="px-4 py-2 text-right tabular-nums">
                        {s.before === s.after ? (s.after ?? '—') : `${s.before ?? '—'} → ${s.after ?? '—'}`}
                      </td>
                    ))}
                    <td className="px-4 py-2 text-right font-semibold tabular-nums">
                      {g.finalBefore === g.finalAfter ? (g.finalAfter ?? '尚未完成') : `${g.finalBefore ?? '尚未完成'} → ${g.finalAfter ?? '尚未完成'}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-4">
          <ApplySchemeForm cohortId={p.cohortId} versionId={p.versionId} versionNo={p.versionNo} token={p.token} requestId={randomUUID()} blocked={p.blockers.length > 0} />
        </div>
      </Card>
    </div>,
  )
}
