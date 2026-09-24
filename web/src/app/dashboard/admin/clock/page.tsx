import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { Card, DataTable, PageHeader, Tile } from '@/app/_ui/primitives'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { ClockForm } from '@/app/dashboard/admin/clock/clock-form'
import {
  businessClockOverrideEnabled,
  CLOCK_REASON_MAX_LENGTH,
  getBusinessClockQuery,
} from '@/composition/cohorts'
import { formatTaipeiSecond, toTaipeiDateTimeInput } from '@/shared/time'

export const metadata = { title: '模擬業務鐘｜資管系專題平台' }

/**
 * 模擬業務鐘（票 11；產品模組 02 §4「模擬業務日期規則」）。
 *
 * 只有測試站（`BUSINESS_CLOCK_OVERRIDE_ENABLED=true`）有這一頁；正式站連網址都是 404，
 * 設定用例也會拒絕（見 actions.ts）。它只改階段、開放、截止、到期這些業務判斷，
 * 不動登入、session、稽核的真實時間。
 */
export default async function AdminClockPage() {
  // 環境先判：正式站不管是誰來，都當作沒有這一頁。
  if (!businessClockOverrideEnabled()) notFound()
  await requireRole('/dashboard/admin/clock', 'admin')

  const query = getBusinessClockQuery()
  const [state, history] = await Promise.all([query.state(), query.history(50)])

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/timeline">
      <PageHeader
        title="模擬業務鐘"
        description="測試站專用：把系統認定的「今天」設到任何一秒，用來驗階段切換與截止前後。正式站沒有這個功能。"
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2">
        <Tile
          label="業務時間"
          value={<span aria-label="目前業務時間">{formatTaipeiSecond(state.businessNow)}</span>}
          hint={state.latest ? '模擬中：從最新一次設定起跟著真實時間往前走' : '沒有模擬：等於真實時間'}
        />
        <Tile label="真實時間" value={formatTaipeiSecond(state.realNow)} hint="登入、稽核、備份用這個，不受模擬影響" />
      </div>

      <Card title="設定業務時間" className="mb-6">
        <ClockForm
          requestId={randomUUID()}
          defaultBusinessAt={toTaipeiDateTimeInput(state.businessNow)}
          reasonMaxLength={CLOCK_REASON_MAX_LENGTH}
        />
      </Card>

      <section aria-label="設定紀錄" className="space-y-3">
        <h2 className="text-base font-semibold text-ink">設定紀錄</h2>
        <DataTable
          columns={['設定時（真實時間）', '操作者', '原因', '設定前', '設定後']}
          rows={history.map((h) => [
            <span key="real" className="whitespace-nowrap tabular-nums">
              {formatTaipeiSecond(h.realAt)}
            </span>,
            h.setByName ?? '—',
            <span key="reason" className="block min-w-[10rem]">
              {h.reason}
            </span>,
            <span key="before" className="whitespace-nowrap tabular-nums">
              {h.previousBusinessAt ? formatTaipeiSecond(h.previousBusinessAt) : '—'}
            </span>,
            <span key="after" className="whitespace-nowrap tabular-nums">
              {formatTaipeiSecond(h.businessAt)}
            </span>,
          ])}
          empty="還沒有設定過，業務時間就是真實時間。"
        />
        <p className="text-xs text-muted-foreground">
          紀錄只增不改，永遠以最新一筆為準。回到{' '}
          <Link href="/dashboard/admin/timeline" className="text-primary hover:underline">
            時間軸
          </Link>{' '}
          看「現在階段」怎麼變。
        </p>
      </section>
    </DashboardShell>
  )
}
