import 'server-only'
import { cache } from 'react'
import type { AccountSummary } from '@/application/accounts'
import type { TeacherQueueEntry } from '@/application/grading'
import type { TeacherSignoffCard } from '@/application/signoff'
import { renderActor } from '@/app/_ui/guard'
import { teacherSignoffSummary } from '@/app/dashboard/teacher/signoff-summary'
import { getAccountDirectoryCommand } from '@/composition/accounts'
import { getGradingQuery } from '@/composition/grading'
import { getSignoffQuery } from '@/composition/signoff'

/**
 * 側欄徽章與角色首頁共用的資料（SH-P2，設計方案 §2.0、§3.11）。
 *
 * 用 React `cache` 以 `userId` 為 key：同一次 RSC render 裡徽章（`nav-badges.ts`）與頁面各叫一次，
 * 只打一次資料庫。身分一律來自 `renderActor()`，交給用例判權限；`userId` 只當快取 key，
 * 跟這次請求的人對不上就當寫錯（只准讀本人）。
 *
 * 只准在 Server Component 用：Server Action、Route Handler 不得 import（lint `fju/no-cached-actor-in-actions`）。
 */

async function actorFor(userId: string) {
  const actor = await renderActor()
  if (actor.kind !== 'authenticated' || actor.userId !== userId) {
    throw new Error('[workload] userId 必須是這次請求的本人')
  }
  return actor
}

/** 老師的待評清單與簽核卡（首頁待辦卡要明細）；`toGrade`、`signoffReady` 是徽章的數字。 */
export const loadTeacherWorkload = cache(
  async (
    userId: string,
  ): Promise<{
    queue: readonly TeacherQueueEntry[]
    signoffCards: readonly TeacherSignoffCard[]
    toGrade: number
    signoffReady: number
  }> => {
    const actor = await actorFor(userId)
    const [queue, signoffCards] = await Promise.all([getGradingQuery().teacherQueue(actor), getSignoffQuery().teacherView(actor)])
    return {
      queue,
      signoffCards,
      toGrade: queue.filter((e) => e.state !== 'counted').length,
      signoffReady: teacherSignoffSummary(signoffCards).readyGroups,
    }
  },
)

/** 系辦帳號摘要（首頁、帳號頁、徽章「待審數」）；用例拒絕時回 `null`。 */
export const loadAdminSummary = cache(async (userId: string): Promise<AccountSummary | null> => {
  const actor = await actorFor(userId)
  const summary = await getAccountDirectoryCommand().summary(actor)
  return summary.ok ? summary.receipt : null
})
