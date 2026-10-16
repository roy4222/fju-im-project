'use server'
// 反例：Server Action 讀快取住的身分 `renderActor()`。action 會在同一個請求裡先改狀態再重畫，
// 快取住的舊身分可能被拿去做判斷；action／route 只准用不快取的 `currentActor()`（SH-P1）。
// 預期被擋：fju/no-cached-actor-in-actions
import { renderActor } from '@/app/_ui/guard'

export async function submitDemo() {
  const actor = await renderActor()
  return { ok: actor.kind === 'authenticated' }
}
