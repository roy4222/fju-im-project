import 'server-only'
import { cache } from 'react'
import type { Role } from '@/application/accounts'
import { shellViewer } from '@/app/_ui/guard'
import type { BadgeCounts } from '@/app/_ui/nav-badge-rules'
import { loadAdminSummary, loadTeacherWorkload } from '@/app/_ui/workload'
import { studentOpenCount, studentTodos } from '@/app/dashboard/student/_todo/todos'
import { actorHasRole, checkStatus } from '@/composition/accounts'
import { getInboxQuery } from '@/composition/inbox'

/**
 * 側欄徽章與通知鈴鐺的數字（票 30）。每一個都用 React `cache` 包：同一次渲染只算一次，
 * 鈴鐺與側欄的未讀數共用同一次查詢；換頁時重算（跟 `shellViewer` 同一個道理）。
 *
 * 範圍一律是本人：身分來自 `shellViewer()`，每個查詢都是首頁磚已經在用、以 actor 或本人 userId 為範圍的那一個，
 * 用例自己也會再判權限。角色不對、帳號狀態被擋，就一個數字都不算。
 * 任何一個讀不到（資料庫暫時有問題）只少那一個徽章，不讓整個後台跟著壞。
 *
 * 老師、系辦的數字讀 `workload.ts` 的 loader（SH-P2）：首頁與帳號頁讀同一個，同一次渲染不重查。
 * `requireRole` 通過後就先叫一次 `navBadgeCounts(role)` 暖快取，外框拿到時查詢已經跟頁面同時在跑。
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

  // 學生（SH-1-ST）：只有「交作業」一顆，跟首頁、交作業頁讀同一份 `studentTodos`（同一次渲染不重查）。
  if (role === 'student') {
    const studentPending = await safe('待辦數', async () => studentOpenCount(await studentTodos(actor.userId)))
    return { studentPending }
  }

  if (role === 'teacher') {
    const [unread, teacherToGrade, teacherSignoff] = await Promise.all([
      unreadCount(),
      safe('待評數', async () => (await loadTeacherWorkload(actor.userId)).toGrade),
      safe('待同意數', async () => (await loadTeacherWorkload(actor.userId)).signoffReady),
    ])
    return { unread, teacherToGrade, teacherSignoff }
  }

  const [unread, adminPendingApplications] = await Promise.all([
    unreadCount(),
    safe('待審數', async () => (await loadAdminSummary(actor.userId))?.pendingApplications ?? 0),
  ])
  return { unread, adminPendingApplications }
})
