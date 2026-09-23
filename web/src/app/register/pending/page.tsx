import { Card, EmptyState } from '@/app/_ui/primitives'
import { NarrowShell } from '@/app/_ui/site-shell'

export const metadata = { title: '等待審核｜資管系專題平台' }

/** 待審核的人登入後會停在這裡；看狀態與改申請的功能由 S01-09／S01-11。 */
export default function RegisterPendingPage() {
  return (
    <NarrowShell>
      <Card title="等待系辦審核" description="系辦核對名單與身分後才會開通，這段期間你可以修改自己的申請。">
        <EmptyState
          pending
          title="申請狀態還看不到"
          description="申請內容、退回理由與修改紀錄由 S01-09／S01-11 掛上來。"
          action={{ href: '/account', label: '去我的帳號' }}
        />
      </Card>
    </NarrowShell>
  )
}
