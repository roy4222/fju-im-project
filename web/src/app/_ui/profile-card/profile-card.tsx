import type { ReactNode } from 'react'
import { IconMail } from '@tabler/icons-react'
import { AvatarImg } from '@/app/_ui/avatar/avatar-img'
import type { AvatarUser } from '@/application/accounts'
import { cn } from '@/shared/cn'

/** 卡片要的欄位：本人名片（`ProfileCard`）與找隊員名單（`TeammateCard`）都是這個形狀的超集。 */
export type ProfileCardView = AvatarUser & {
  readonly studentNo: string | null
  readonly departmentClass: string | null
  readonly bio: string
  readonly skills: readonly string[]
  readonly contactEmail: string
}

/**
 * 一張學生名片（C3 設計方案 §4.3、§4.4；票 C3-07）。Server Component：「我的帳號」的預覽與找隊員名單用同一張。
 *
 * 頭像 64px、姓名、學號、系級（空就不顯示那行）、一句話自介（空則灰字「還沒寫自介」）、技能膠囊、`mailto:` Email。
 * 電話永遠不在卡上。`footer` 放卡片底部的動作（「邀請加入」或公開狀態）。整張是一個 `article`，名稱是姓名。
 */
export function ProfileCard({ card, footer, className }: { card: ProfileCardView; footer?: ReactNode; className?: string }) {
  return (
    <article aria-label={card.name} className={cn('flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-4', className)}>
      <div className="flex min-w-0 items-center gap-3">
        <AvatarImg user={card} size={64} decorative />
        <div className="min-w-0">
          <p className="truncate text-[15px] font-bold">{card.name}</p>
          {card.studentNo ? <p className="tabular truncate text-xs text-muted-foreground">{card.studentNo}</p> : null}
          {card.departmentClass ? <p className="truncate text-xs text-muted-foreground">{card.departmentClass}</p> : null}
        </div>
      </div>
      {card.bio ? <p className="text-sm break-words">{card.bio}</p> : <p className="text-sm text-muted-foreground">還沒寫自介</p>}
      {card.skills.length > 0 ? (
        <ul aria-label="技能" className="flex flex-wrap gap-1.5">
          {card.skills.map((skill) => (
            <li key={skill} className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-semibold text-foreground">
              {skill}
            </li>
          ))}
        </ul>
      ) : null}
      <a
        href={`mailto:${card.contactEmail}`}
        className="inline-flex min-w-0 items-center gap-1 text-xs font-semibold text-ink hover:underline"
      >
        <IconMail className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{card.contactEmail}</span>
      </a>
      {footer ? <div className="mt-auto border-t border-border/70 pt-3">{footer}</div> : null}
    </article>
  )
}
