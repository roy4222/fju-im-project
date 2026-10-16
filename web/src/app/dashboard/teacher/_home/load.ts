import 'server-only'
import { loadTeacherWorkload } from '@/app/_ui/workload'
import { loadStage } from '@/app/dashboard/_stage'
import type { ResolvedActor } from '@/application/accounts'
import type { AudienceKind } from '@/application/items'
import { getTimelineQuery } from '@/composition/cohorts'
import { getPublicItemQuery } from '@/composition/items'
import { getAdvisorSubmissionQuery } from '@/composition/submissions'
import { taipeiDateOf } from '@/shared/time'

/**
 * 「給老師的公告」列哪幾種對象（Q13、Q14，2026-09-26 定案）：全部老師、所有已登入、指定組別（前台查詢只回
 * 自己指導的組）。「本屆學生」與「公開」不列在這裡——指導老師在 `/news` 仍看得到，只是不佔首頁。
 */
const TEACHER_NEWS: readonly AudienceKind[] = ['teachers', 'signed_in', 'groups']

/**
 * 老師首頁唯一的讀取入口（老師規格 §4.1、§5；TE-07）：頁面各段只拿這個物件，查詢一次 `Promise.all` 發出。
 *
 * 待評清單與簽核卡讀共用 `loadTeacherWorkload(userId)`（SH-P2，`_ui/workload.ts`）：側欄徽章讀的是同一份
 * （React `cache`，同一次 render 只查一次），橫幅、待辦卡與徽章的數字因此同源；這裡不再自己呼叫
 * `teacherQueue`／`teacherView`（AC-TE-08、AC-SH-37）。
 *
 * 「本屆活動」：老師目前指導的屆別（Q13「自己指導那一屆」，不一定是工作屆別）＋系辦設定的工作屆別；
 * 指導的屆別跟階段一起查，活動等兩者回來再查（每屆一句，同時發）。
 */
export async function loadTeacherHome(actor: ResolvedActor) {
  // 頁面先過了 `requireRole`，這裡一定是登入的老師。
  if (actor.kind !== 'authenticated') throw new Error('[teacher home] 要登入的老師')
  const stageRead = loadStage(actor, 'staff')
  const advisedRead = getPublicItemQuery().advisedCohortIds(actor)
  const [stage, workload, matrix, news, activities] = await Promise.all([
    stageRead,
    loadTeacherWorkload(actor.userId),
    getAdvisorSubmissionQuery().matrix(actor),
    // 前台查詢已依看的人過濾（指定組別只回自己指導的組）；SQL 先篩這三種對象再取 5 則，不會被公開公告擠掉。
    getPublicItemQuery().list(actor, 'news', { audiences: TEACHER_NEWS, limit: 5 }),
    Promise.all([stageRead, advisedRead]).then(async ([ctx, advisedCohorts]) => {
      const cohortIds = [...new Set([...(ctx.cohort ? [ctx.cohort.id] : []), ...advisedCohorts])]
      const lists = await Promise.all(cohortIds.map((id) => getTimelineQuery().activities(id)))
      // 今天以後、沒取消的，早的在前；「本屆學生」的活動只算指導的屆別（其他對象老師本來就在內）。
      const upcoming = lists
        .flat()
        .filter((a) => a.status === 'scheduled' && taipeiDateOf(a.startsAt) >= ctx.today)
        .filter((a) => a.audienceKind !== 'cohort_students' || advisedCohorts.includes(a.cohortId))
        .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
        .slice(0, 5)
      return { advisedCohorts, upcoming }
    }),
  ])
  return { stage, workload, queue: workload.queue, signoffCards: workload.signoffCards, matrix, news, activities }
}

export type TeacherHome = Awaited<ReturnType<typeof loadTeacherHome>>
