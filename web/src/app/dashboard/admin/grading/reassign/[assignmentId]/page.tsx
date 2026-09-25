import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { Card, EmptyState } from '@/app/_ui/primitives'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { ReassignForm } from '@/app/dashboard/admin/grading/results-forms'
import { getGradebookQuery } from '@/composition/grading'

export const metadata = { title: '移除或改派評分老師｜資管系專題平台' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 移除或改派評分老師的預覽（票 24；產品 06 §4「7.4 評分要求與採計」Q-GRD01、GRD-13、GRD-15）。
 *
 * 一頁一件事：上面是現在的採計（誰的分數、份數、平均、最終），下面是三種選擇各自之後的樣子（保留／替換／新增），
 * 選一個、（替換、新增時）選接手的老師、填理由再確認。頁面載入時拿到的 `basis_hash` 跟著表單送出；
 * 預覽之後有人送分、退回、改派、改份數或套用方案，執行時被拒並請你重新預覽（重新整理這一頁）。
 */
export default async function ReassignPage({ params }: { params: Promise<{ assignmentId: string }> }) {
  const { assignmentId } = await params
  const actor = await requireRole(`/dashboard/admin/grading/reassign${UUID.test(assignmentId) ? `/${assignmentId}` : ''}`, 'admin')
  if (!UUID.test(assignmentId)) notFound()
  const preview = await getGradebookQuery().previewReassignment(actor, assignmentId)

  const back = preview.ok ? `/dashboard/admin/grading?cohort=${preview.receipt.cohortId}` : '/dashboard/admin/grading'
  const shell = (children: React.ReactNode) => (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/grading">
      <Link href={back} className="mb-4 inline-flex text-sm font-medium text-muted-foreground hover:text-foreground">
        ← 評分
      </Link>
      <header className="mb-5">
        <h1 className="text-xl font-semibold text-foreground">移除或改派評分老師</h1>
      </header>
      {children}
    </DashboardShell>
  )

  if (!preview.ok) return shell(<EmptyState title="現在不能改派這個指派" description={preview.message} />)
  const p = preview.receipt

  return shell(
    <div className="space-y-6">
      <Card title={`${p.groupCode}「${p.stageName}」・${p.teacherName} 老師`}>
        <dl className="grid gap-3 text-sm sm:grid-cols-4" data-testid="reassign-before">
          <div>
            <dt className="text-xs text-muted-foreground">現在採計</dt>
            <dd className="tabular-nums text-foreground">{p.countedBefore.map((c) => `${c.teacherName} ${c.display}`).join('、') || '沒有'}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">份數</dt>
            <dd className="tabular-nums text-foreground">
              {p.countedBefore.length}／{p.requiredBefore ?? '未設定'}・{p.stageStatusBefore}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">階段平均</dt>
            <dd className="tabular-nums text-foreground">{p.averageBefore ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">最終成績</dt>
            <dd className="tabular-nums text-foreground">{p.finalBefore ?? '尚未完成'}</dd>
          </div>
        </dl>
        <p className="mt-3 text-sm text-muted-foreground">
          {p.hasCounted ? `${p.teacherName} 老師已正式送出分數，請選這一筆怎麼算。` : `${p.teacherName} 老師還沒有正式分數，只能「替換」（可以只移除）。`}
          {p.hasDraft ? '他的暫存會標成失效（保留內容與原因，只有系辦查得到），不會轉給新老師。' : ''}
          移除的只是這一組這一階段的評分權限；主指導或其他階段的指派不受影響。
        </p>
      </Card>
      <Card title="三種選擇">
        <ReassignForm preview={p} requestId={randomUUID()} />
      </Card>
    </div>,
  )
}
