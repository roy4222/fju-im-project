'use client'
import { useActionState, useRef, useState } from 'react'
import { IconX } from '@tabler/icons-react'
import { AvatarImg } from '@/app/_ui/avatar/avatar-img'
import type { ProfileCard } from '@/application/accounts'
import { cn } from '@/shared/cn'

/** 存名片的回饋（伺服器回的句子）。 */
export type ProfileCardActionState = { ok: boolean; message: string } | undefined

export type ProfileCardLimits = {
  readonly bioMax: number
  readonly skillMaxCount: number
  readonly skillMaxLength: number
  readonly presets: readonly string[]
}

const INPUT =
  'mt-1.5 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none transition-[border-color,box-shadow] ' +
  'focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25'
const LABEL = 'block text-sm font-semibold'
// 對話框外觀同 `_ui/dashboard/look.ts` 的 DIALOG.lg／DIALOG_TITLE／DIALOG_DESC／BTN_SUBMIT。不 import 那個檔：它在模組層呼叫
// `buttonVariants`，會把按鈕樣式庫拉進找隊員分頁的首載（C3-07 量過 +2 KB）。
const DIALOG_LG =
  'm-auto max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-xl border-0 bg-popover p-0 text-sm text-popover-foreground ring-1 ring-foreground/10 ' +
  'backdrop:bg-black/10 backdrop:backdrop-blur-xs w-[min(32rem,calc(100vw-2rem))]'
const DIALOG_TITLE = 'text-lg font-extrabold text-foreground'
const DIALOG_DESC = 'mt-1 text-sm text-muted-foreground'
const BTN_SUBMIT = 'btn-fju h-11 px-5 text-sm disabled:pointer-events-none disabled:opacity-60'
const TRIGGER =
  'press inline-flex h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-border bg-background px-4 ' +
  'text-sm font-semibold text-foreground transition-colors hover:bg-muted'

/** 跟伺服器同一套字數算法（code point），即時字數才不會跟送出結果對不上。 */
const length = (value: string) => Array.from(value).length

/**
 * 「編輯我的名片」按鈕＋視窗（C3 設計方案 §4.3；票 C3-07）。「我的帳號」與找隊員分頁用同一個。
 *
 * 原生 `<dialog>`（焦點鎖、Esc 是瀏覽器的）；表單是 Server Action，存完頁面 refresh，卡片預覽跟著更新，視窗不會被換掉。
 * 瀏覽器端只做順手的提示（即時字數、勾太多、自訂技能太長）；規則以伺服器為準，直接打 action 一樣會被擋。
 */
export function ProfileCardDialog({
  card,
  limits,
  action,
  requestId,
  avatarHref,
  emailEditable = true,
}: {
  card: ProfileCard
  limits: ProfileCardLimits
  action: (state: ProfileCardActionState, formData: FormData) => Promise<ProfileCardActionState>
  requestId: string
  /** 「更換頭像」連去哪裡（頭像卡在「我的帳號」，這裡不重做上傳）。 */
  avatarHref: string
  /**
   * 能不能在這裡改聯絡 Email（預設可以）。「我的帳號」傳 false：同一頁的「基本資料」也改同一個 `contact_email`，
   * 一頁只留一個輸入框；存檔沿用目前的 Email，中途被改過靠 revision 回 CONFLICT（C3-17）。
   */
  emailEditable?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [state, formAction, pending] = useActionState(action, undefined)
  const [bio, setBio] = useState(card.bio)
  const [skills, setSkills] = useState<string[]>([...card.skills])
  const [custom, setCustom] = useState('')
  const [hint, setHint] = useState<string | null>(null)
  const [email, setEmail] = useState(card.contactEmail)
  const [open, setOpen] = useState(card.openToJoin)
  // 伺服器那邊的名片變了（頁面上的開關、別的分頁存過）：欄位跟著換成最新的，不會把舊狀態存回去（C3-07 r1）。
  // 不用 key 重掛：自己存完也會變版本，重掛會把視窗關掉、「名片已更新」也跟著不見。
  const serverKey = `${card.revision}-${card.openToJoin}`
  const [seenKey, setSeenKey] = useState(serverKey)
  if (seenKey !== serverKey) {
    setSeenKey(serverKey)
    setBio(card.bio)
    setSkills([...card.skills])
    setEmail(card.contactEmail)
    setOpen(card.openToJoin)
  }

  const options = [...limits.presets, ...skills.filter((s) => !limits.presets.includes(s))]
  const bioLength = length(bio)

  function toggle(skill: string, checked: boolean) {
    setHint(null)
    if (!checked) return setSkills((list) => list.filter((s) => s !== skill))
    if (skills.includes(skill)) return
    if (skills.length >= limits.skillMaxCount) return setHint(`最多 ${limits.skillMaxCount} 個技能。`)
    setSkills((list) => [...list, skill])
  }

  function addCustom() {
    const skill = custom.trim()
    if (!skill) return
    // 跟既有的重複（去空白後）：不新增、不報錯，順手勾起來。
    if (options.includes(skill)) {
      setCustom('')
      if (!skills.includes(skill)) toggle(skill, true)
      return
    }
    if (length(skill) > limits.skillMaxLength) return setHint(`每個技能最多 ${limits.skillMaxLength} 字。`)
    if (skills.length >= limits.skillMaxCount) return setHint(`最多 ${limits.skillMaxCount} 個技能。`)
    setHint(null)
    setCustom('')
    setSkills((list) => [...list, skill])
  }

  return (
    <>
      <button type="button" className={TRIGGER} onClick={() => ref.current?.showModal()}>
        編輯我的名片
      </button>
      <dialog ref={ref} aria-label="編輯我的名片" className={DIALOG_LG}>
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 className={DIALOG_TITLE}>編輯我的名片</h2>
            <p className={DIALOG_DESC}>公開找隊員時，同屆同學會在「找隊員」看到這張卡。電話不會公開。</p>
          </div>
          <button
            type="button"
            onClick={() => ref.current?.close()}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="關閉"
          >
            <IconX className="size-4" aria-hidden />
          </button>
        </div>
        <form action={formAction} className="flex flex-col gap-5 px-5 py-5">
          <input type="hidden" name="requestId" value={requestId} />
          <input type="hidden" name="revision" value={card.revision} />
          {skills.map((skill) => (
            <input key={skill} type="hidden" name="skill" value={skill} />
          ))}

          <div className="flex items-center gap-3">
            <AvatarImg user={card} size={64} />
            <div className="min-w-0">
              <p className="truncate font-bold">{card.name}</p>
              <a href={avatarHref} className="text-sm font-semibold text-ink hover:underline">
                更換頭像
              </a>
            </div>
          </div>

          <div>
            <label htmlFor="profile-card-bio" className={LABEL}>
              一句話自我介紹
            </label>
            <textarea
              id="profile-card-bio"
              name="bio"
              rows={2}
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              aria-describedby="profile-card-bio-count"
              className={cn(INPUT, 'py-2')}
            />
            <p
              id="profile-card-bio-count"
              className={cn('tabular mt-1 text-right text-xs', bioLength > limits.bioMax ? 'font-bold text-destructive' : 'text-muted-foreground')}
            >
              {bioLength}／{limits.bioMax}
            </p>
          </div>

          <fieldset>
            <legend className={LABEL}>我會什麼（最多 {limits.skillMaxCount} 個）</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {options.map((skill) => (
                <label
                  key={skill}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border px-3 py-1 text-sm has-[:checked]:border-brand has-[:checked]:bg-brand-subtle"
                >
                  <input type="checkbox" checked={skills.includes(skill)} onChange={(e) => toggle(skill, e.target.checked)} />
                  {skill}
                </label>
              ))}
            </div>
            <div className="mt-3 flex gap-2">
              <input
                aria-label="自訂技能"
                placeholder="輸入自訂技能"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addCustom()
                  }
                }}
                className={cn(INPUT, 'mt-0 h-10')}
              />
              <button type="button" onClick={addCustom} className={TRIGGER}>
                新增
              </button>
            </div>
            {hint ? (
              <p role="alert" className="mt-2 text-sm text-destructive">
                {hint}
              </p>
            ) : null}
          </fieldset>

          {emailEditable ? (
            <div>
              <label htmlFor="profile-card-email" className={LABEL}>
                聯絡 Email
              </label>
              <input id="profile-card-email" name="contactEmail" type="email" value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={cn(INPUT, 'h-11')}
              />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              <input type="hidden" name="contactEmail" value={card.contactEmail} />
              聯絡 Email 在上面「基本資料」改
            </p>
          )}

          <div>
            <label className="inline-flex items-center gap-2 text-sm font-semibold">
              <input
                type="checkbox"
                name="openToJoin"
                value="true"
                checked={open}
                onChange={(e) => setOpen(e.target.checked)}
                disabled={!card.canOpenToJoin}
              />
              公開找隊員
            </label>
            {!card.canOpenToJoin ? <p className="mt-1 text-xs text-muted-foreground">已經有組別，不會出現在找隊員名單</p> : null}
          </div>

          {state ? (
            <p
              role={state.ok ? 'status' : 'alert'}
              className={cn(
                'rounded-lg px-4 py-2.5 text-sm',
                state.ok ? 'bg-success-subtle text-success-on-subtle' : 'bg-destructive-subtle text-destructive-on-subtle',
              )}
            >
              {state.message}
            </p>
          ) : null}
          <button type="submit" disabled={pending} className={BTN_SUBMIT}>
            {pending ? '儲存中…' : '儲存'}
          </button>
        </form>
      </dialog>
    </>
  )
}
