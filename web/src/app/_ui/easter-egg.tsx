import './easter-egg.css'
import type * as EggRules from '@/app/_ui/easter-egg-rules'

/**
 * 頁首 logo 彩蛋（規格④ 設計方案 §10，規則在 `easter-egg-rules.ts`）：首頁 5 秒內連點 10 次；
 * 第 3 下起 logo 晃並預載 FlyingButton，第 10 下起飛＋訊息。減少動態：不晃、不下載 FlyingButton，第 10 下只顯示訊息。
 *
 * 這支（連同 CSS）是首頁第一次點 logo 才下載（載入樁在 `dash-theme.tsx`，主腦裁定 C4-09 ESCALATE 1）：
 * 頁首只負責判斷這一下算不算、`preventDefault()`，計數與畫面都在這裡直接改 DOM。
 * 不 import 任何共用模組（連 `easter-egg-rules.ts` 也是由頁首傳進來，避免 Turbopack 重切共用 chunk、後台多一份深淺色 chunk）；FlyingButton 的載入樁也由頁首傳進來。
 * 計數存在 logo 那個 `<a>` 上：頁首用 `key={pathname}` 換頁就換一個新的 `<a>`（`data-egg-count="0"`），等於歸零。
 * 延遲下載的時序（#773 Review r1）：時間用點擊當下（頁首傳 `at`），不用下載完成的時間；
 * 下載回來時 logo 已不在頁面上（換頁了）就不算；換頁時頁首呼叫 `eggLeave()` 收掉訊息、計時器與還在飛的分身。
 */

const MESSAGE = '恭喜發現彩蛋！資管系祝你專題順利 🎉'
const MESSAGE_MS = 6000

type FlyingModule = typeof import('@/app/_ui/fx/flying-button')
type Rules = typeof EggRules
type Egg = EggRules.EggState & { reset?: number; flying?: Promise<FlyingModule>; stop?: (() => void) | null }

const eggs = new WeakMap<HTMLAnchorElement, Egg>()
let message: { el: HTMLElement; timer: number } | null = null
let active: Egg | null = null

function paint(logo: HTMLAnchorElement, count: number, eggStage: Rules['eggStage']) {
  logo.dataset.eggCount = String(count)
  logo.classList.toggle('is-shaking', eggStage(count) === 'shake')
}

function showMessage() {
  if (message) window.clearTimeout(message.timer)
  const el = message?.el ?? document.createElement('p')
  el.setAttribute('role', 'status')
  el.dataset.testid = 'easter-egg'
  el.className = 'easter-egg-message'
  el.textContent = MESSAGE
  if (!el.isConnected) document.body.append(el)
  message = { el, timer: window.setTimeout(() => (el.remove(), (message = null)), MESSAGE_MS) }
}

/** 離開首頁（換頁）：訊息、歸零計時器、還在飛的分身都收掉。 */
export function eggLeave() {
  if (message) {
    window.clearTimeout(message.timer)
    message.el.remove()
    message = null
  }
  if (active) {
    window.clearTimeout(active.reset)
    active.stop?.()
    active.stop = null
    active = null
  }
}

/** 記一下 logo 點擊（頁首已確認這一下要算、也已 `preventDefault()`）；`at` 是點擊當下的時間。 */
export function eggLogoClick(logo: HTMLAnchorElement, at: number, rules: Rules, loadFlying: () => Promise<FlyingModule>) {
  if (!logo.isConnected) return
  const { EGG_START, EGG_WINDOW_MS, eggClick, eggStage } = rules
  const egg: Egg = eggs.get(logo) ?? { ...EGG_START }
  active = egg
  eggs.set(logo, Object.assign(egg, eggClick(egg, at)))
  paint(logo, egg.count, eggStage)
  window.clearTimeout(egg.reset)
  const stage = eggStage(egg.count)
  // 超過 5 秒沒點完：晃動停、計數歸零。
  if (stage !== 'fire') {
    egg.reset = window.setTimeout(() => {
      Object.assign(egg, EGG_START)
      paint(logo, 0, eggStage)
    }, EGG_WINDOW_MS - (Date.now() - egg.since) + 1)
  }
  if (stage === 'idle') return
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  if (!reduced) egg.flying ??= loadFlying()
  if (stage !== 'fire') return
  showMessage()
  const img = logo.querySelector('img')
  if (reduced || egg.stop || !img) return
  void egg.flying
    ?.then((m) => {
      if (!logo.isConnected || egg.stop) return
      egg.stop = m.launchFlyingButton(img, () => (egg.stop = null))
    })
    .catch(() => {})
}
