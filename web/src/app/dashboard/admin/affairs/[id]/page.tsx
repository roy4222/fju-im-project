import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireRole } from '@/app/_ui/guard'
import { IconClock } from '@tabler/icons-react'
import { BackLink, BTN_INK, PageTitle, Pill } from '@/app/_ui/dashboard-kit'
import { EmptyState } from '@/app/_ui/primitives'
import { DashboardShell } from '@/app/_ui/site-shell'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { ConsentBoard } from '@/app/dashboard/admin/affairs/[id]/consent-board'
import { RemindButton } from '@/app/dashboard/admin/affairs/[id]/remind-button'
import { FieldsPanel, ReceiverView, RosterList, VersionView, type ListKey, type RosterPeople } from '@/app/dashboard/admin/affairs/[id]/roster-views'
import { VisibilityPanel } from '@/app/dashboard/admin/affairs/[id]/visibility-panel'
import { CompletionPanel } from '@/app/dashboard/_submissions/completion-panel'
import type { AvatarUser } from '@/application/accounts'
import type { RosterEntry } from '@/application/submissions'
import { cohortLabel, getBusinessClock, getCohortStatusQuery } from '@/composition/cohorts'
import { getGroupQuery } from '@/composition/groups'
import { getItemQuery, ITEM_STATUS_LABEL, RECEIVER_UNIT_LABEL } from '@/composition/items'
import { describeCooldown, getReminderQuery } from '@/composition/reminders'
import { getSignoffQuery } from '@/composition/signoff'
import { categoryOf, completionOf, getRosterQuery, getSubmissionQuery } from '@/composition/submissions'
import { addTaipeiDays, formatTaipeiMinute, isDeadlinePassed, taipeiDateOf } from '@/shared/time'

export const metadata = { title: '繳交狀況｜資管系專題平台' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LISTS: readonly ListKey[] = ['current', 'exempt', 'removed']

function one(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * 繳交狀況頁（票 18；C 階段規格① §4.2、C1-07 重做：頂部催繳鈕、名單表、理由選填）。
 *
 * - 頂部：標題、截止、「催繳未繳（N 人）」（§8、AC-12；24 小時一次，冷卻中停用並寫下次可催的時間）、「編輯」。
 *   N＝名單上還沒交的人（整組一份展開成組員，口徑同催繳用例）。
 * - 名單表：組別／人（頭像）、狀態、最後繳交時間、動作「查看」「設免繳／恢復」「讓他補交」（理由都選填，AC-11）。
 * - 站內同意書（`consentMode='form'`）的進度看簽核包：同意書看板（`ConsentBoard`，C1-11），不渲染名單。
 *
 * - 名單分三類：目前名單、免填、已移出（`?list=`）。完成率＝已正式送出／應交數，應交數不含免填與已移出
 *   （產品模組 05 §4「個人填報與收件名單」）。每一列的狀態與學生作業區、學生首頁用同一個函式算。
 * - 點一個人（`?person=`）看名單紀錄與每一次正式送出；再點一次（`&version=`）看那一次的回答（唯讀）。
 *   已移出的人回答保留，一樣點得進去。草稿內容不在這裡顯示，只標「有草稿、最後儲存時間」。
 * - 只有系辦管理員看得到：頁面守角色，查詢本身再判一次（老師、學生拿到的是 null → 404）。
 *   移出、加回、催繳這些**操作**在之後的票（開發計畫「之後再做：名單變動與到期工作」）。
 * - 設免繳／恢復（B 階段 A-08）：「目前名單」每列「設免繳」（理由選填）、「免繳」每列「恢復」；已交過的人也能設，繳交保留。
 *   屆別封存後不放這兩個按鈕（用例另外回 `COHORT_ARCHIVED`）。
 * - 讓單一學生或單一組補交（第三波 W10）：截止後在名單列或點進去的那一位畫面按「讓他補交」，填期限（理由選填）；只通知那一位。
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
  const [cohortStatus, detail] = await Promise.all([getCohortStatusQuery().get(item.cohortId), getItemQuery().get(item.itemId)])
  const archived = cohortStatus?.status === 'archived'
  const consentForm = detail?.consentMode === 'form'
  const individual = item.receiverUnit === 'individual'
  const base = `/dashboard/admin/affairs/${item.itemId}`

  // 截止含當分鐘（Vault 04 §4）：跟收件判定用同一個 helper。
  const overdue = item.dueAt !== null && isDeadlinePassed(businessNow, item.dueAt)

  // 組員（頭像、催繳人數）：組別收件是組 id → 組員，個人收件是學生 id → 本人。
  const groups = await getGroupQuery().cohortGroups(item.cohortId, { history: false })
  const people: RosterPeople = individual
    ? new Map(groups.flatMap((g) => g.members.map((m) => [m.userId, [avatarOf(m)]] as const)))
    : new Map(groups.map((g) => [g.id, g.members.map(avatarOf)] as const))

  // 催繳（§8）：發布中、屆別沒封存才放。人數口徑同催繳用例（目前名單、還沒正式送出；整組展開成組員）。
  let remind: React.ReactNode = null
  if (item.status === 'published' && !archived) {
    const pending = entries.filter((e) => categoryOf(e) === 'current' && e.latestVersionNo === null)
    const count = individual ? pending.length : pending.reduce((n, e) => n + (people.get(e.receiverId)?.length ?? 0), 0)
    const last = await getReminderQuery().lastReminded(actor, 'item', item.itemId)
    const cooling = last.ok && last.receipt.at && last.receipt.nextAllowedAt ? describeCooldown(last.receipt.at, last.receipt.nextAllowedAt, new Date()) : null
    remind = (
      <RemindButton
        itemId={item.itemId}
        count={count}
        unknownCount={consentForm}
        blocked={cooling ?? (!consentForm && count === 0 ? '名單上的人都交了' : null)}
        requestId={randomUUID()}
      />
    )
  }

  const shell = (children: React.ReactNode) => (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/affairs">
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-3">
          <BackLink href={`/dashboard/admin/affairs/assignments?cohort=${item.cohortId}`} label="作業" />
          <div>
            <p className="text-xs font-semibold text-muted-foreground">
              {cohortLabel({ name: item.cohortName, code: item.cohortCode })}・文件繳交・{RECEIVER_UNIT_LABEL[item.receiverUnit]}
              {item.stageName ? `・${item.stageName}` : ''}
            </p>
            <PageTitle
              title={item.title}
              description={`${ITEM_STATUS_LABEL[item.status]}${item.dueAt ? `・${formatTaipeiMinute(item.dueAt)} 截止（含此分鐘）` : '・沒有截止'}`}
              actions={
                <>
                  {item.dueAt ? (
                    <Pill tone={overdue ? 'danger' : 'brand'}>
                      <IconClock aria-hidden />
                      {overdue ? '已截止' : '開放繳交中'}・{formatTaipeiMinute(item.dueAt)}
                    </Pill>
                  ) : null}
                  {item.schemaVersionNo ? <Pill>表單第 {item.schemaVersionNo} 版</Pill> : null}
                  {remind}
                  <Link href={`/dashboard/admin/editor/${item.itemId}`} className={BTN_INK}>
                    編輯
                  </Link>
                </>
              }
            />
          </div>
        </div>
        {children}
      </div>
    </DashboardShell>
  )

  // 點一個人（整組一份：一組）：名單紀錄＋每一次正式送出；帶版本號就看那一次的內容。
  if (personId) {
    if (!UUID.test(personId)) notFound()
    const [detail, reopens] = await Promise.all([
      rosterQuery.receiver(actor, item.itemId, personId),
      getSubmissionQuery().reopens(actor, item.itemId, personId),
    ])
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
        <ReceiverView
          base={base}
          detail={detail}
          window={item}
          businessNow={businessNow}
          reopens={reopens ?? []}
          reopen={
            // 讓他補交（W10）：已截止、發布中、還在目前名單上（不是免填、沒被移出）才能開。
            overdue && item.status === 'published' && categoryOf(detail.entry) === 'current'
              ? {
                  itemId: item.itemId,
                  receiverId: personId,
                  defaultDueAt: `${addTaipeiDays(taipeiDateOf(businessNow), 1)}T17:00`,
                  requestId: randomUUID(),
                }
              : null
          }
        />
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
          title="還沒發布，還沒有需要繳交的名單"
          description="發布時才依「誰看得到」的設定建立需要繳交的名單；發布前可以在編輯器的發布檢查展開看會收到的人。"
          action={{ href: `/dashboard/admin/editor/${item.itemId}`, label: '回編輯器' }}
        />
        {visibilityPanel}
      </div>,
    )
  }

  if (consentForm) {
    // 站內同意書的進度看簽核包（§6.3、C1-11）：每組一塊同意書看板，不渲染名單。
    const board = await getSignoffQuery().itemBoard(actor, item.itemId)
    return shell(
      board.ok ? (
        <ConsentBoard board={board.receipt} archived={archived} />
      ) : (
        <EmptyState title="讀不到同意書進度" description={board.message} />
      ),
    )
  }

  const completion = completionOf(item, entries, businessNow)
  const grouped: Record<ListKey, RosterEntry[]> = { current: [], exempt: [], removed: [] }
  for (const entry of entries) grouped[categoryOf(entry)].push(entry)

  return shell(
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <RosterList
        base={base}
        list={list}
        grouped={grouped}
        window={item}
        businessNow={businessNow}
        individual={individual}
        exemptItemId={archived ? null : item.itemId}
        people={people}
        reopen={
          // 讓他補交（W10）：已截止、發布中才開（名單列只放在目前名單、還沒交的那幾列）。
          overdue && item.status === 'published'
            ? { itemId: item.itemId, defaultDueAt: `${addTaipeiDays(taipeiDateOf(businessNow), 1)}T17:00` }
            : null
        }
      />
      <div className="flex flex-col gap-5">
        <CompletionPanel completion={completion} individual={individual} />
        {visibilityPanel}
        <FieldsPanel fields={item.fields} schemaVersionNo={item.schemaVersionNo} />
      </div>
    </div>,
  )
}

function avatarOf(m: { userId: string; name: string; avatarPreset: number | null; avatarFileId: string | null }): AvatarUser {
  return { id: m.userId, name: m.name, avatarPreset: m.avatarPreset, avatarFileId: m.avatarFileId }
}
