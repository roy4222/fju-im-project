import { UserAvatar } from '@/app/_ui/avatar/user-avatar'
import type { VersionDetail } from '@/application/signoff'
import { cn } from '@/shared/cn'
import { taipeiParts } from '@/shared/time'

/**
 * 同意書「狀態」分頁的「全組狀態」表（C 階段規格① §6.2、AC-22）：每位組員一列（頭像、姓名、「已同意 m/d」／「不同意」／「還沒表態」），
 * 最後一列是指導老師。看的人自己那一列右側放 `action`（本人表態表單；投過就不給，按鈕自然消失）。
 *
 * 不顯示版本號、文件一致性檢查碼、檔案核對碼、登入方式（資料都還在，系辦匯出 CSV 看得到）。
 * 學生、老師的同意書頁共用這一張；資料是 `VersionDetail.progress`（三個角色看到的數字一樣）。
 */

function monthDay(at: Date): string {
  const p = taipeiParts(at)
  return `${p.month}/${p.day}`
}

type Person = VersionDetail['progress']['advisor']

function statusText(p: Person, advisor: boolean, v: VersionDetail): { text: string; tone: string } {
  if (p.result === 'agree') return { text: `已同意 ${monthDay(p.at!)}`, tone: 'text-success-on-subtle' }
  if (p.result === 'disagree') return { text: '不同意', tone: 'text-danger' }
  if (p.result === 'return') return { text: '退回', tone: 'text-danger' }
  if (advisor && v.state === 'collecting') return { text: '組員全部同意後輪到老師', tone: 'text-muted-foreground' }
  return { text: '還沒表態', tone: 'text-muted-foreground' }
}

function Row({ p, advisor, v, action }: { p: Person; advisor: boolean; v: VersionDetail; action: React.ReactNode }) {
  const me = p.userId === v.viewer.userId
  const status = statusText(p, advisor, v)
  return (
    <li
      className={cn('flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3', advisor && 'bg-surface')}
      data-testid={advisor ? 'group-status-advisor' : 'group-status-row'}
    >
      <UserAvatar user={{ id: p.userId, name: p.displayName, avatarPreset: p.avatarPreset, avatarFileId: p.avatarFileId }} size={32} decorative />
      <span className={cn('font-medium', me && 'font-bold')}>
        {p.displayName}
        {me ? '（你）' : ''}
      </span>
      {advisor ? <span className="text-xs text-muted-foreground">指導老師</span> : null}
      <span className={cn('ml-auto text-sm font-semibold', status.tone)} data-testid="group-status-result">
        {status.text}
      </span>
      {p.reason ? <span className="w-full text-xs text-muted-foreground">理由：{p.reason}</span> : null}
      {me && action ? <div className="w-full pt-1">{action}</div> : null}
    </li>
  )
}

export function GroupStatus({ v, action }: { v: VersionDetail; action?: React.ReactNode }) {
  const p = v.progress
  return (
    <section aria-label="全組狀態" className="dash-card overflow-hidden" data-testid="group-status">
      <h2 className="flex flex-wrap items-baseline gap-2 border-b border-border px-4 py-3 text-[15px] font-bold">
        全組狀態
        <span className="text-sm font-semibold text-muted-foreground tabular-nums" data-testid="group-status-count">
          {p.agreed}／{p.total} 位組員已同意
        </span>
      </h2>
      <ul className="divide-y divide-border text-sm">
        {p.students.map((s) => (
          <Row key={s.userId} p={s} advisor={false} v={v} action={action} />
        ))}
        <Row p={p.advisor} advisor v={v} action={action} />
      </ul>
    </section>
  )
}
