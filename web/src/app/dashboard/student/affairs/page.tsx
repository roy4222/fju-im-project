import Link from 'next/link'
import { IconHistory, IconPaperclip, IconUser, IconUsersGroup } from '@tabler/icons-react'
import { PageTitle, Panel, PanelEmpty } from '@/app/_ui/dashboard-primitives'
import { requireRole } from '@/app/_ui/guard'
import { buttonVariants } from '@/app/_ui/ui/button'
import { DashboardShell } from '@/app/_ui/site-shell'
import { STUDENT_NAV } from '@/app/dashboard/_nav'
import { STUDENT_TONE_CLASS } from '@/app/dashboard/student/affairs/tone'
import type { MyItemRow, MyRecordRow } from '@/application/submissions'
import { getBusinessClock } from '@/composition/cohorts'
import { getSubmissionQuery, receiverStatus } from '@/composition/submissions'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute, taipeiDateOf, taipeiDayStart } from '@/shared/time'

export const metadata = { title: '作業區｜資管系專題平台' }

const TABS = [
  { key: 'all', label: '全部' },
  { key: 'open', label: '待繳' },
  { key: 'done', label: '已繳交' },
  { key: 'overdue', label: '逾期未繳' },
] as const

type TabKey = (typeof TABS)[number]['key']

/**
 * 學生作業區（票 17；原型 `/dashboard/student/affairs`）：一列一件，欄位是「作業名稱／形式／狀態／截止」。
 * 外觀照原型（票 38）：頁標題一行數字、一張白卡裡是篩選 pill、桌面表格／手機一件一張卡。
 *
 * 只列**自己在目前收件名單上**的收件（發布中）：個人一份看本人、整組一份看自己此刻所在的組（票 21）。
 * 狀態字（尚未開放／未繳／已繳 vN／逾期未繳）由 application 的 `statusOf` 算，列表與內容頁同一個口徑；
 * 開放與截止都看業務時鐘（測試站可以撥）。整組一份時任一位組員送出，全組的這一列都變成已繳。
 * 最下面「我的繳交紀錄」（票 22）：已經不在作業區、但本人讀得到的正式版本（被移出組別或名單的人唯讀）。
 */
export default async function StudentAffairsPage({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole('/dashboard/student/affairs', 'student')
  const userId = actor.kind === 'authenticated' ? actor.userId : ''
  const params = await searchParams
  const tab: TabKey = TABS.find((t) => t.key === params.tab)?.key ?? 'all'

  const query = getSubmissionQuery()
  const [rows, records, businessNow] = await Promise.all([query.myItems(userId), query.myRecords(userId), getBusinessClock().now()])
  // 狀態字與首頁待繳數、管理員名單頁同一個函式（票 18）。
  const items = rows.map((row) => ({ row, status: receiverStatus(row, row, businessNow) }))
  const inTab = (key: TabKey) =>
    items.filter(({ status }) =>
      key === 'open' ? status.pending : key === 'done' ? status.submitted : key === 'overdue' ? status.overdue : true,
    )
  const list = inTab(tab)
  const count = (key: TabKey) => inTab(key).length
  const active = TABS.find((t) => t.key === tab)!
  // 原型標題下一行先寫組別代號（整組一份的收件才知道是哪一組）。
  const groupCode = rows.find((row) => row.groupCode)?.groupCode ?? null

  const dueText = (dueAt: Date) => formatTaipeiMinute(dueAt)
  // 截止欄第二行（原型）：剩幾天／今天截止／逾期幾天／已繳可重送；天數用臺灣日期算（業務時鐘的今天）。
  const today = taipeiDayStart(taipeiDateOf(businessNow)).getTime()
  const daysLeft = (dueAt: Date) => Math.round((taipeiDayStart(taipeiDateOf(dueAt)).getTime() - today) / 86_400_000)
  const dueHint = (dueAt: Date, status: (typeof items)[number]['status']) => {
    const d = daysLeft(dueAt)
    if (status.overdue) return { text: `逾期 ${Math.abs(d)} 天`, cls: 'text-destructive' }
    if (status.submitted) return { text: status.editable ? `剩 ${d} 天可重送` : '已截止', cls: 'text-muted-foreground' }
    const text = d < 0 ? '已截止' : d === 0 ? '今天截止' : `剩 ${d} 天`
    return { text, cls: status.pending && d <= 10 ? 'font-semibold text-brand-on-subtle' : 'text-muted-foreground' }
  }

  return (
    <DashboardShell roleLabel="學生" items={STUDENT_NAV} current="/dashboard/student/affairs">
      <div className="flex flex-col gap-5">
        <PageTitle
          title="作業區"
          description={`${groupCode ? `${groupCode}・` : ''}待繳 ${count('open')}・已繳交 ${count('done')}${
            count('overdue') ? `・逾期未繳 ${count('overdue')}` : ''
          }`}
        />

        <Panel title={active.label} description={`${list.length} 件・你在收件名單上的收件`}>
          <nav aria-label="篩選" className="-mx-1 flex gap-1.5 overflow-x-auto border-b border-border/70 px-5 pb-3 [scrollbar-width:none]">
            {TABS.map((t) => {
              const on = t.key === tab
              return (
                <Link
                  key={t.key}
                  href={t.key === 'all' ? '/dashboard/student/affairs' : `/dashboard/student/affairs?tab=${t.key}`}
                  aria-current={on ? 'page' : undefined}
                  scroll={false}
                  className={cn(
                    'inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full border px-4 text-sm font-semibold whitespace-nowrap transition-colors',
                    // 原型選中的篩選是深藍實心（原型 primary＝深藍，正式碼叫 ink）。
                    on ? 'border-ink bg-ink text-ink-foreground' : 'border-border text-foreground hover:bg-accent',
                  )}
                >
                  {t.label}
                  <span className={cn('tabular text-xs', on ? 'text-ink-foreground/80' : 'text-muted-foreground')}>{count(t.key)}</span>
                </Link>
              )
            })}
          </nav>

          {list.length === 0 ? (
            <PanelEmpty
              title={tab === 'all' ? '目前沒有要交的收件' : `沒有${active.label}的收件`}
              hint="系辦發布收件、而且你（或你的組別）在收件名單上時，會出現在這裡；有新收件時通知匣也會有一則。整組一份的收件要先成立組別。"
            />
          ) : (
            <>
              {/* 手機：一件一列的卡片 */}
              <ul className="divide-y divide-border/70 sm:hidden" aria-label="收件列表">
                {list.map(({ row, status }) => (
                  <li key={row.itemId} className="flex flex-col gap-2 px-5 py-4">
                    <Link href={`/dashboard/student/affairs/${row.itemId}`} className="text-[15px] font-bold">
                      {row.title}
                    </Link>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
                      <span className={cn('font-semibold', STUDENT_TONE_CLASS[status.tone])}>{status.headline}</span>
                      <span className="text-muted-foreground">{status.detail}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="tabular min-w-0 flex-1 text-[13px] text-muted-foreground">
                        {/* 手機只寫月日（原型）；完整的截止分鐘在內容頁。 */}
                        {row.dueAt ? `${dueText(row.dueAt).slice(5, 10)} 截止${status.pending ? `・${dueHint(row.dueAt, status).text}` : ''}` : '無截止'}・
                        {unitText(row)}
                      </span>
                      <ActionLink itemId={row.itemId} label={status.action} primary={status.pending} className="h-11" />
                    </div>
                  </li>
                ))}
              </ul>

              {/* 桌面：表格 */}
              <div className="hidden overflow-x-auto sm:block">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="bg-muted/40 text-left text-[12px] text-muted-foreground">
                      <th scope="col" className="px-5 py-2.5 font-semibold">
                        作業名稱
                      </th>
                      <th scope="col" className="px-4 py-2.5 font-semibold">
                        形式
                      </th>
                      <th scope="col" className="px-4 py-2.5 font-semibold">
                        狀態
                      </th>
                      <th scope="col" className="px-4 py-2.5 font-semibold">
                        截止
                      </th>
                      <th scope="col" className="px-5 py-2.5">
                        <span className="sr-only">動作</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map(({ row, status }) => (
                      <tr
                        key={row.itemId}
                        className="border-t border-border/70 transition-colors hover:bg-accent/40"
                        data-testid={`affair-${row.itemId}`}
                      >
                        <td className="px-5 py-3.5">
                          {/* 連結只包標題（連結名稱＝作業名稱）；階段與附件數是下面一行灰字。 */}
                          <Link href={`/dashboard/student/affairs/${row.itemId}`} className="block text-[15px] font-bold">
                            {row.title}
                          </Link>
                          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                            <span>階段：{row.stageName ?? '未指定'}</span>
                            {row.attachmentCount > 0 ? (
                              <span className="inline-flex items-center gap-1">
                                <IconPaperclip className="size-3.5" aria-hidden />
                                {row.attachmentCount} 個附件
                              </span>
                            ) : null}
                          </span>
                        </td>
                        <td className="px-4 py-3.5 whitespace-nowrap">
                          <span className="inline-flex items-center gap-1.5">
                            {row.receiverUnit === 'group' ? (
                              <IconUsersGroup className="size-4 text-ink" aria-hidden />
                            ) : (
                              <IconUser className="size-4 text-ink" aria-hidden />
                            )}
                            {unitText(row)}
                          </span>
                        </td>
                        <td className="px-4 py-3.5 whitespace-nowrap">
                          <span className={cn('block font-semibold', STUDENT_TONE_CLASS[status.tone])}>{status.headline}</span>
                          <span className="block text-[12px] text-muted-foreground">{status.detail}</span>
                        </td>
                        <td className="tabular px-4 py-3.5 whitespace-nowrap">
                          {row.dueAt ? (
                            <>
                              <span className="block">{dueText(row.dueAt)}</span>
                              <span className={cn('block text-[12px]', dueHint(row.dueAt, status).cls)}>{dueHint(row.dueAt, status).text}</span>
                            </>
                          ) : (
                            <span className="text-muted-foreground">無截止</span>
                          )}
                        </td>
                        <td className="px-5 py-3.5 text-right">
                          <ActionLink itemId={row.itemId} label={status.action} primary={status.pending} className="h-10" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Panel>

        {records.length > 0 ? <Records records={records} /> : null}
      </div>
    </DashboardShell>
  )
}

/**
 * 我的繳交紀錄（票 22；產品模組 05 SUB-20、25）：已經不在作業區、但本人讀得到的正式版本。
 * 被移出組別的人只看得到自己還在組裡時送出的版本；被移出個人收件名單的人看得到自己的回答。唯讀。
 * 原型沒有這一塊；外觀用同一種白卡（Panel）。
 */
function Records({ records }: { records: readonly MyRecordRow[] }) {
  return (
    <Panel title="我的繳交紀錄（唯讀）" icon={<IconHistory />} description="已經不在你作業區的收件">
      <p className="px-5 pb-3 text-[13px] text-muted-foreground">
        已經不在你作業區的收件。離開組別後，只看得到你還在組裡時送出的版本與附件；不能再填寫或送出。
      </p>
      <ul className="divide-y divide-border/70 border-t border-border/70" aria-label="我的繳交紀錄" data-testid="my-records">
        {records.map((r) => (
          <li key={`${r.itemId}:${r.receiverId}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3.5">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-bold">{r.title}</span>
              <span className="block text-xs text-muted-foreground tabular-nums">
                {r.receiverKind === 'group' ? `整組一份（${r.groupCode ?? ''}）` : '個人一份'}・你看得到 {r.versionCount} 個版本・最後一版 v
                {r.latestVersionNo} 於 {formatTaipeiMinute(r.latestReceivedAt)}
              </span>
            </span>
            <Link
              href={`/dashboard/student/affairs/${r.itemId}?record=${r.receiverId}`}
              className="press inline-flex h-10 shrink-0 items-center rounded-lg border border-border bg-background px-4 text-sm font-medium transition-colors hover:bg-muted"
            >
              查看紀錄
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

/** 列尾的按鈕：待繳用橘色實心（原型 btn-fju），其他用白底細框。 */
function ActionLink({ itemId, label, primary, className }: { itemId: string; label: string; primary: boolean; className?: string }) {
  return (
    <Link
      href={`/dashboard/student/affairs/${itemId}`}
      className={
        primary
          ? cn('btn-fju shrink-0 rounded-lg px-4 text-sm', className)
          : buttonVariants({ variant: 'outline', className: cn('press shrink-0 rounded-lg px-4 text-sm', className) })
      }
    >
      {label}
    </Link>
  )
}

/** 形式欄：個人一份，或整組一份（帶自己組別的代號）。 */
function unitText(row: MyItemRow): string {
  return row.receiverUnit === 'group' ? `整組一份${row.groupCode ? `（${row.groupCode}）` : ''}` : '個人一份'
}
