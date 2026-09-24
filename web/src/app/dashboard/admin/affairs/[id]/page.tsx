import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireRole } from '@/app/_ui/guard'
import { EmptyState, LinkButton } from '@/app/_ui/primitives'
import { DashboardShell } from '@/app/_ui/site-shell'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { FieldsPanel, ReceiverView, RosterList, VersionView, type ListKey } from '@/app/dashboard/admin/affairs/[id]/roster-views'
import { VisibilityPanel } from '@/app/dashboard/admin/affairs/[id]/visibility-panel'
import { CompletionPanel } from '@/app/dashboard/_submissions/completion-panel'
import type { RosterEntry } from '@/application/submissions'
import { getBusinessClock } from '@/composition/cohorts'
import { ITEM_STATUS_LABEL, RECEIVER_UNIT_LABEL } from '@/composition/items'
import { categoryOf, completionOf, getRosterQuery } from '@/composition/submissions'
import { formatTaipeiMinute } from '@/shared/time'

export const metadata = { title: '收件名單｜資管系專題平台' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LISTS: readonly ListKey[] = ['current', 'exempt', 'removed']

function one(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * 收件名單頁（票 18；原型 `/dashboard/admin/affairs/[id]` 的各人狀態、收件進度環、欄位摘要）。
 *
 * - 名單分三類：目前名單、免填、已移出（`?list=`）。完成率＝已正式送出／應交數，應交數不含免填與已移出
 *   （產品模組 05 §4「個人填報與收件名單」）。每一列的狀態與學生作業區、學生首頁用同一個函式算。
 * - 點一個人（`?person=`）看名單紀錄與每一次正式送出；再點一次（`&version=`）看那一次的回答（唯讀）。
 *   已移出的人回答保留，一樣點得進去。草稿內容不在這裡顯示，只標「有草稿、最後儲存時間」。
 * - 只有系辦管理員看得到：頁面守角色，查詢本身再判一次（老師、學生拿到的是 null → 404）。
 *   免填、移出、加回、個別重開、催繳這些**操作**在之後的票（開發計畫「之後再做：名單變動與到期工作」）。
 * - 整組一份（票 21）：名單三類列組別；完成率以組為單位（同組誰送都算一份）；點一組看它每一次正式送出與附件。
 * - 個人一份（票 22）：右欄多一塊「主指導閱覽」開關（SUB-24）；已經有人作答就不能開。
 */
export default async function RosterPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ list?: string | string[]; person?: string | string[]; version?: string | string[] }>
}) {
  const { id } = await params
  // 受保護路由：跟 `/dashboard/admin/editor/<id>` 一樣掛在 `/dashboard/admin/affairs` 那一列（`_nav.ts`）。
  const actor = await requireRole(`/dashboard/admin/affairs${UUID.test(id) ? `/${id}` : ''}`, 'admin')
  if (!UUID.test(id)) notFound()
  const search = await searchParams
  const list: ListKey = LISTS.find((l) => l === one(search.list)) ?? 'current'
  const personId = one(search.person)
  const versionNo = Number(one(search.version) ?? NaN)

  const rosterQuery = getRosterQuery()
  const [roster, businessNow] = await Promise.all([rosterQuery.roster(actor, id), getBusinessClock().now()])
  if (!roster) notFound()
  const { item, entries } = roster
  const individual = item.receiverUnit === 'individual'
  const base = `/dashboard/admin/affairs/${item.itemId}`

  const shell = (children: React.ReactNode) => (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/affairs">
      <Link
        href={`/dashboard/admin/affairs?cohort=${item.cohortId}`}
        className="mb-4 inline-flex text-sm font-medium text-muted-foreground hover:text-ink"
      >
        ← 專題事務
      </Link>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-primary">
            {item.cohortCode}・文件繳交・{RECEIVER_UNIT_LABEL[item.receiverUnit]}
            {item.stageName ? `・${item.stageName}` : ''}
          </p>
          <h1 className="mt-0.5 text-xl font-semibold text-ink">{item.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground tabular-nums">
            {ITEM_STATUS_LABEL[item.status]}
            {item.dueAt ? `・${formatTaipeiMinute(item.dueAt)} 截止（含此分鐘）` : '・沒有截止'}
            {item.schemaVersionNo ? `・欄位 v${item.schemaVersionNo}` : ''}
          </p>
        </div>
        <LinkButton href={`/dashboard/admin/editor/${item.itemId}`} variant="secondary">
          編輯內容
        </LinkButton>
      </header>
      {children}
    </DashboardShell>
  )

  // 點一個人（整組一份：一組）：名單紀錄＋每一次正式送出；帶版本號就看那一次的內容。
  if (personId) {
    if (!UUID.test(personId)) notFound()
    const detail = await rosterQuery.receiver(actor, item.itemId, personId)
    if (!detail) notFound()
    const version =
      Number.isInteger(versionNo) && versionNo > 0
        ? await rosterQuery.receiverVersion(actor, item.itemId, personId, versionNo)
        : null
    if (one(search.version) !== undefined && !version) notFound()
    return shell(
      version ? (
        <VersionView base={base} detail={detail} version={version} />
      ) : (
        <ReceiverView base={base} detail={detail} window={item} businessNow={businessNow} />
      ),
    )
  }

  // 主指導閱覽（個人一份才有）：發布前就要能開好，所以「還沒發布」的畫面也放。
  const visibility = individual ? await rosterQuery.advisorVisibility(actor, item.itemId) : null
  const visibilityPanel = visibility ? (
    <VisibilityPanel
      itemId={item.itemId}
      enabled={visibility.current?.enabled ?? false}
      effectiveFromVersionNo={visibility.current?.effectiveFromVersionNo ?? null}
      changedText={
        visibility.current
          ? `${visibility.current.setByName} 於 ${formatTaipeiMinute(visibility.current.setAt)} ${visibility.current.enabled ? '開放' : '關閉'}`
          : null
      }
      hasResponses={visibility.hasResponses}
      requestId={randomUUID()}
    />
  ) : null

  if (item.status === 'draft' && entries.length === 0) {
    return shell(
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <EmptyState
          title="還沒發布，還沒有收件名單"
          description="發布時才依對象建立收件名單；發布前可以在編輯器的發布檢查展開看會收到的人。"
          action={{ href: `/dashboard/admin/editor/${item.itemId}`, label: '回編輯器' }}
        />
        {visibilityPanel}
      </div>,
    )
  }

  const completion = completionOf(item, entries, businessNow)
  const grouped: Record<ListKey, RosterEntry[]> = { current: [], exempt: [], removed: [] }
  for (const entry of entries) grouped[categoryOf(entry)].push(entry)

  return shell(
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <RosterList base={base} list={list} grouped={grouped} window={item} businessNow={businessNow} individual={individual} />
      <div className="flex flex-col gap-5">
        <CompletionPanel completion={completion} individual={individual} />
        {visibilityPanel}
        <FieldsPanel fields={item.fields} schemaVersionNo={item.schemaVersionNo} />
      </div>
    </div>,
  )
}
