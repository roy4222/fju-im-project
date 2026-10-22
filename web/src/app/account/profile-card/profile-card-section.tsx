import { randomUUID } from 'node:crypto'
import { saveProfileCardAction } from '@/app/account/profile-card/actions'
import { ProfileCard } from '@/app/_ui/profile-card/profile-card'
import { ProfileCardDialog, type ProfileCardLimits } from '@/app/_ui/profile-card/profile-card-dialog'
import type { ProfileCard as ProfileCardData, ResolvedActor } from '@/application/accounts'
import { BIO_MAX_LENGTH, getProfileCardQuery, SKILL_MAX_COUNT, SKILL_MAX_LENGTH, SKILL_PRESETS } from '@/composition/accounts'

/** 名片視窗要的上限與預設技能（client 元件拿不到 composition，由伺服器帶進去）。 */
export const PROFILE_CARD_LIMITS: ProfileCardLimits = {
  bioMax: BIO_MAX_LENGTH,
  skillMaxCount: SKILL_MAX_COUNT,
  skillMaxLength: SKILL_MAX_LENGTH,
  presets: SKILL_PRESETS,
}

/**
 * 「我的帳號」第四張卡「我的名片」（C3 設計方案 §4.3；票 C3-07）。只有學生有，老師、系辦回 null（不畫）。
 *
 * 掛進 `account/page.tsx` 的那一行在 C3-17（等②C2-13 的帳號頁外殼）；這張票先把元件做好，
 * 找隊員分頁的「編輯我的名片」用同一個視窗。
 */
export async function ProfileCardSection({ actor }: { actor: ResolvedActor }) {
  const card = await getProfileCardQuery().mine(actor)
  if (!card) return null
  return (
    <section aria-label="我的名片" className="dash-card flex flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[17px] font-extrabold tracking-tight">我的名片</h2>
        <ProfileCardEditor card={card} emailEditable={false} />
      </div>
      <ProfileCard
        card={card}
        footer={
          <p className="text-xs text-muted-foreground">
            公開找隊員：<strong className="text-foreground">{card.openToJoin ? '已公開' : '未公開'}</strong>
          </p>
        }
      />
    </section>
  )
}

/**
 * 「編輯我的名片」按鈕＋視窗（找隊員分頁也用這個，請求編號在伺服器產生）。
 * `emailEditable`：「我的帳號」傳 false，聯絡 Email 只在同頁「基本資料」改（C3-17）；找隊員分頁照預設可改。
 */
export function ProfileCardEditor({ card, emailEditable = true }: { card: ProfileCardData; emailEditable?: boolean }) {
  return (
    <ProfileCardDialog
      card={card}
      limits={PROFILE_CARD_LIMITS}
      action={saveProfileCardAction}
      requestId={randomUUID()}
      avatarHref="/account"
      emailEditable={emailEditable}
    />
  )
}
