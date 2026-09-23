import { Card, EmptyState } from '@/app/_ui/primitives'
import { NarrowShell } from '@/app/_ui/site-shell'

export const metadata = { title: '註冊｜資管系專題平台' }

/** 註冊表單由 S01-09 掛上來；老師帳號由系辦建立，不走這一頁。 */
export default function RegisterPage() {
  return (
    <NarrowShell>
      <Card title="學生註冊" description="老師帳號由系辦建立，不需要在這裡註冊。">
        <EmptyState
          pending
          title="註冊表單還沒做"
          description="姓名、學號、系級、手機與聯絡 Email 的表單由 S01-09 掛上來；送出後會進入待審核。"
          action={{ href: '/login', label: '已經有帳號，去登入' }}
        />
      </Card>
    </NarrowShell>
  )
}
