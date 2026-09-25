import { describe, expect, it } from 'vitest'
import type { TeacherSignoffCard } from '@/application/signoff'
import { teacherSignoffSummary } from '@/app/dashboard/teacher/signoff-summary'

function card(patch: {
  groupId: string
  purpose?: TeacherSignoffCard['purpose']
  state: TeacherSignoffCard['current']['state']
  isSnapshotAdvisor?: boolean
  voted?: TeacherSignoffCard['mine']['voted']
}): TeacherSignoffCard {
  return {
    groupId: patch.groupId,
    groupCode: patch.groupId.toUpperCase(),
    cohortCode: '114',
    purpose: patch.purpose ?? 'result_confirmation',
    current: {
      versionId: `${patch.groupId}-${patch.purpose ?? 'result_confirmation'}`,
      versionNo: 1,
      state: patch.state,
      cause: null,
      studentCount: 5,
      createdAt: new Date('2026-09-25T00:00:00Z'),
      // 摘要只看狀態與 mine，進度內容不影響；給一份最小的。
      progress: {
        students: [],
        advisor: { userId: 't1', displayName: '老師', studentNo: null, result: null, reason: null, at: null },
        agreed: 0,
        total: 0,
        missing: [],
      },
      lastEventAt: new Date('2026-09-25T00:00:00Z'),
    },
    mine: { isSnapshotAdvisor: patch.isSnapshotAdvisor ?? true, voted: patch.voted ?? null },
  }
}

describe('老師首頁的同意書摘要：數字以組別為單位', () => {
  it('同一組兩個簽核包都輪到老師：清單兩列，「待我同意」算 1 組', () => {
    const s = teacherSignoffSummary([
      card({ groupId: 'g1', purpose: 'result_confirmation', state: 'teacher_pending' }),
      card({ groupId: 'g1', purpose: 'final_document', state: 'teacher_pending' }),
    ])
    expect(s.ready).toHaveLength(2)
    expect(s.readyGroups).toBe(1)
  })

  it('等待學生也依組別去重；不同組各算一組', () => {
    const s = teacherSignoffSummary([
      card({ groupId: 'g1', purpose: 'result_confirmation', state: 'collecting' }),
      card({ groupId: 'g1', purpose: 'final_document', state: 'collecting' }),
      card({ groupId: 'g2', state: 'collecting' }),
    ])
    expect(s.waiting).toHaveLength(3)
    expect(s.waitingGroups).toBe(2)
  })

  it('已經表態、或不是這一版快照的主指導：不算待我同意', () => {
    const s = teacherSignoffSummary([
      card({ groupId: 'g1', state: 'teacher_pending', voted: 'agree' }),
      card({ groupId: 'g2', state: 'teacher_pending', isSnapshotAdvisor: false }),
      card({ groupId: 'g3', state: 'complete' }),
    ])
    expect(s.readyGroups).toBe(0)
    expect(s.waitingGroups).toBe(0)
  })
})
