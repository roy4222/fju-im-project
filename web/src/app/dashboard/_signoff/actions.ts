'use server'
import { refresh } from 'next/cache'
import { currentActor } from '@/app/_ui/guard'
import type { RespondActionState } from '@/app/dashboard/_signoff/respond-form'
import type { VoteDecision } from '@/application/signoff'
import { describeRespondReceipt, getSignoffCommand } from '@/composition/signoff'

/**
 * 學生與老師的「表態」動作（票 26）。**只有本人一票**：表單沒有、也不收「替誰」的欄位——
 * 投票的人由這次請求的 session 決定（`currentActor()`），登入方式也是從同一個 session 讀出來。
 * 版本、內容核對碼、同意或不同意、理由照送來的樣子交給用例判（舊頁、過期頁、不是參與者、投過了都在用例裡擋）。
 */

const text = (formData: FormData, name: string, max = 200) => String(formData.get(name) ?? '').slice(0, max)

export async function respondAction(_state: RespondActionState, formData: FormData): Promise<RespondActionState> {
  // 不是 agree／reject 的值由用例拒絕（VALIDATION_FAILED），這裡不默默改寫。
  const decision = text(formData, 'decision', 20)
  const result = await getSignoffCommand().respond(
    await currentActor(),
    {
      versionId: text(formData, 'versionId', 100),
      contentChecksum: text(formData, 'contentChecksum', 100),
      decision: decision as VoteDecision,
      // 上限由用例判（說得出是多少）；這裡只擋掉離譜的大小。
      reason: text(formData, 'reason', 5_000),
    },
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: describeRespondReceipt(result.receipt) }
}
