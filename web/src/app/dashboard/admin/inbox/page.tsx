import { randomUUID } from 'node:crypto'
import { requireRole } from '@/app/_ui/guard'
import { Card, PageHeader } from '@/app/_ui/primitives'
import { DashboardShell } from '@/app/_ui/site-shell'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { InboxView } from '@/app/dashboard/_inbox/inbox-view'
import { TestNotificationForm } from '@/app/dashboard/admin/inbox/test-notification-form'
import { getCohortStatusQuery } from '@/composition/cohorts'
import { getTestNotificationCommand, TEST_NOTIFICATION_TITLE_MAX_LENGTH } from '@/composition/inbox'

export const metadata = { title: '通知｜資管系專題平台' }

type Search = Promise<{ cohort?: string | string[]; cursor?: string | string[] }>

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)

/**
 * 系辦的通知匣（票 12）。測試站多一張「發一則測試通知」，用來驗證「發事件→背景工作投影→通知匣」。
 */
export default async function AdminInboxPage({ searchParams }: { searchParams: Search }) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole('/dashboard/admin/inbox', 'admin')
  const params = await searchParams
  const testCommand = getTestNotificationCommand()
  const [recipients, cohorts] = testCommand.enabled
    ? await Promise.all([testCommand.recipientOptions(), getCohortStatusQuery().list()])
    : [[], []]

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/inbox">
      <PageHeader title="通知" description="跟你有關的事件都會出現在這裡。已讀狀態跟著帳號，換裝置、重新登入都還在。" />
      {testCommand.enabled ? (
        <Card
          title="發一則測試通知"
          description="測試站專用：選一位收件人發出去，背景工作幾秒內就會把它送進對方的通知匣。正式站沒有這個功能。"
          className="mb-6"
        >
          <TestNotificationForm
            requestId={randomUUID()}
            recipients={recipients}
            cohorts={cohorts.map((c) => ({ cohortId: c.id, code: c.code }))}
            titleMaxLength={TEST_NOTIFICATION_TITLE_MAX_LENGTH}
          />
        </Card>
      ) : null}
      <InboxView actor={actor} basePath="/dashboard/admin/inbox" cohortParam={first(params.cohort)} cursor={first(params.cursor)} />
    </DashboardShell>
  )
}
