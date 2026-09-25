import 'server-only'
import { cache } from 'react'
import type { Role } from '@/application/accounts'
import { shellViewer } from '@/app/_ui/guard'
import type { BadgeCounts } from '@/app/_ui/nav-badge-rules'
import { teacherSignoffSummary } from '@/app/dashboard/teacher/signoff-summary'
import { actorHasRole, checkStatus, getAccountDirectoryCommand } from '@/composition/accounts'
import { getBusinessClock } from '@/composition/cohorts'
import { getGradingQuery } from '@/composition/grading'
import { getInboxQuery } from '@/composition/inbox'
import { getSignoffQuery } from '@/composition/signoff'
import { getSubmissionQuery, pendingCount } from '@/composition/submissions'

/**
 * 側欄徽章與通知鈴鐺的數字（票 30）。每一個都用 React `cache` 包：同一次渲染只算一次，
 * 鈴鐺與側欄的未讀數共用同一次查詢；換頁時重算（跟 `shellViewer` 同一個道理）。
 *
 * 範圍一律是本人：身分來自 `shellViewer()`，每個查詢都是首頁磚已經在用、以 actor 或本人 userId 為範圍的那一個，
 * 用例自己也會再判權限。角色不對、帳號狀態被擋，就一個數字都不算。
 * 任何一個讀不到（資料庫暫時有問題）只少那一個徽章，不讓整個後台跟著壞。
 */

async function safe(label: string, run: () => Promise<number>): Promise<number | undefined> {
  try {
    return await run()
  } catch (error) {
    console.error(`[nav-badges] 讀不到${label}`, error)
    return undefined
  }
}

/** 本人通知未讀數（鈴鐺與側欄「通知」共用）。 */
export const unreadCount = cache(async (): Promise<number | undefined> => {
  const actor = await shellViewer()
  return safe('未讀數', () => getInboxQuery().unreadCount(actor))
})

export const navBadgeCounts = cache(async (role: Role): Promise<BadgeCounts> => {
  const actor = await shellViewer()
  if (actor.kind !== 'authenticated' || checkStatus(actor, 'business') !== null || !actorHasRole(actor, role)) return {}

  if (role === 'student') {
    const [unread, studentPending, studentSignoff] = await Promise.all([
      unreadCount(),
      safe('待繳數', async () => {
        const [items, now] = await Promise.all([getSubmissionQuery().myItems(actor.userId), getBusinessClock().now()])
        return pendingCount(items, now)
      }),
      safe('待表態數', async () => {
        const view = await getSignoffQuery().studentView(actor)
        return view.versions.filter((v) => v.isCurrent && v.viewer.canRespond).length
      }),
    ])
    return { unread, studentPending, studentSignoff }
  }

  if (role === 'teacher') {
    const [unread, teacherToGrade, teacherSignoff] = await Promise.all([
      unreadCount(),
      safe('待評數', async () => (await getGradingQuery().teacherQueue(actor)).filter((e) => e.state !== 'counted').length),
      safe('待同意數', async () => teacherSignoffSummary(await getSignoffQuery().teacherView(actor)).readyGroups),
    ])
    return { unread, teacherToGrade, teacherSignoff }
  }

  const [unread, adminPendingApplications] = await Promise.all([
    unreadCount(),
    safe('待審數', async () => {
      const summary = await getAccountDirectoryCommand().summary(actor)
      return summary.ok ? summary.receipt.pendingApplications : 0
    }),
  ])
  return { unread, adminPendingApplications }
})
