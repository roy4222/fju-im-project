import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StudentSignoffView, VersionDetail } from '@/application/signoff'
import type { MyItemRow } from '@/application/submissions'

const viewer = vi.hoisted(() => ({ current: { kind: 'authenticated', userId: 'u-s' } as { kind: string; userId?: string } }))
const myItems = vi.hoisted(() => vi.fn())
const studentView = vi.hoisted(() => vi.fn())
vi.mock('@/app/_ui/guard', () => ({ shellViewer: async () => viewer.current }))
vi.mock('@/composition/submissions', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSubmissionQuery: () => ({ myItems }),
}))
vi.mock('@/composition/signoff', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSignoffQuery: () => ({ studentView }),
}))
vi.mock('@/composition/cohorts', () => ({ getBusinessClock: () => ({ now: async () => NOW }) }))

import {
  buildTodos,
  consentTodo,
  homeTodos,
  itemTodo,
  nextDue,
  SOON_DAYS,
  studentOpenCount,
  studentTodos,
  todoCounts,
  type StudentTodo,
} from '@/app/dashboard/student/_todo/todos'

// 固定業務鐘：臺灣 2026-08-17 10:00。
const NOW = new Date('2026-08-17T10:00:00+08:00')
const DAY = 86_400_000
/** 從今天算第 n 天的 23:59（臺灣）。 */
const dayEnd = (n: number) => new Date(new Date('2026-08-17T23:59:00+08:00').getTime() + n * DAY)

function item(over: Partial<MyItemRow> & { itemId: string }): MyItemRow {
  return {
    title: over.itemId,
    stageName: null,
    cohortId: 'c1',
    stageSeq: null,
    opensAt: null,
    dueAt: dayEnd(20),
    attachmentCount: 0,
    exempt: false,
    hasDraft: false,
    latestVersionNo: null,
    latestReceivedAt: null,
    receiverUnit: 'individual',
    groupCode: null,
    reopenUntil: null,
    ...over,
  }
}

type ConsentOver = Partial<Pick<VersionDetail, 'state' | 'cause' | 'isCurrent' | 'createdAt' | 'itemId'>> & {
  versionId?: string
  canRespond?: boolean
  voted?: VersionDetail['viewer']['voted']
  votedAt?: Date | null
}

function consent(over: ConsentOver = {}): VersionDetail {
  const versionId = over.versionId ?? 'v2'
  const me = { userId: 'u-s', displayName: 'S', studentNo: '411', result: over.voted ?? null, reason: null, at: over.votedAt ?? null, avatarPreset: null, avatarFileId: null }
  return {
    versionId,
    packageId: 'p1',
    versionNo: 2,
    purpose: 'final_document',
    groupId: 'g07',
    groupCode: 'G07',
    cohortCode: '114',
    cohortName: '114 學年度',
    contentHtml: '<p>全文</p>',
    contentChecksum: 'x',
    attachments: [],
    participants: {
      students: [{ userId: 'u-s', displayName: 'S', studentNo: '411', membershipId: 'm1' }],
      advisor: { userId: 'u-t', displayName: 'T', assignmentId: 'a1' },
    },
    authorizationScope: null,
    supersedeCause: null,
    state: over.state ?? 'collecting',
    cause: over.cause ?? null,
    isCurrent: over.isCurrent ?? true,
    createdAt: over.createdAt ?? new Date('2026-08-10T09:00:00+08:00'),
    createdByName: '系辦',
    history: [],
    progress: {
      students: [me],
      advisor: { userId: 'u-t', displayName: 'T', studentNo: null, result: null, reason: null, at: null, avatarPreset: null, avatarFileId: null },
      agreed: over.voted === 'agree' ? 1 : 0,
      total: 1,
      missing: [],
    },
    viewer: { userId: 'u-s', role: 'student', eligible: true, voted: over.voted ?? null, canRespond: over.canRespond ?? false },
    lastRemindedAt: null,
    exports: [],
    ...(over.itemId !== undefined ? { itemId: over.itemId } : {}),
  }
}

const view = (...versions: VersionDetail[]): StudentSignoffView => ({ groupCode: 'G07', versions })
const pick = (t: StudentTodo) => ({ status: t.status, label: t.label })

describe('itemTodo：作業對到待辦狀態', () => {
  it('還沒截止、沒交：剩 > 10 天待交，≤ 10 天（含今天）快到期（Q118）', () => {
    expect(SOON_DAYS).toBe(10)
    expect(pick(itemTodo(item({ itemId: 'a', dueAt: dayEnd(20) }), NOW))).toEqual({ status: 'open', label: '待交' })
    expect(pick(itemTodo(item({ itemId: 'a', dueAt: dayEnd(11) }), NOW))).toEqual({ status: 'open', label: '待交' })
    expect(pick(itemTodo(item({ itemId: 'a', dueAt: dayEnd(10) }), NOW))).toEqual({ status: 'soon', label: '快到期' })
    expect(pick(itemTodo(item({ itemId: 'a', dueAt: dayEnd(0) }), NOW))).toEqual({ status: 'soon', label: '快到期' })
  })

  it('沒有截止日的作業是待交', () => {
    const t = itemTodo(item({ itemId: 'a', dueAt: null }), NOW)
    expect(pick(t)).toEqual({ status: 'open', label: '待交' })
    expect(t.due).toBeNull()
  })

  it('截止已過、沒交：逾期', () => {
    expect(pick(itemTodo(item({ itemId: 'a', dueAt: dayEnd(-2) }), NOW))).toEqual({ status: 'overdue', label: '逾期' })
  })

  it('送出過：已交（截止前可重送、截止後唯讀都是已交）', () => {
    expect(pick(itemTodo(item({ itemId: 'a', latestVersionNo: 1 }), NOW))).toEqual({ status: 'done', label: '已交' })
    expect(pick(itemTodo(item({ itemId: 'a', dueAt: dayEnd(-2), latestVersionNo: 2 }), NOW))).toEqual({ status: 'done', label: '已交' })
  })

  it('還沒到開放時間：尚未開放（Q119）', () => {
    const row = item({ itemId: 'a', opensAt: new Date(NOW.getTime() + 5 * DAY), dueAt: dayEnd(3) })
    expect(pick(itemTodo(row, NOW))).toEqual({ status: 'notOpen', label: '尚未開放' })
  })

  it('免繳優先於其他狀態（Q119）', () => {
    expect(pick(itemTodo(item({ itemId: 'a', exempt: true, dueAt: dayEnd(-2) }), NOW))).toEqual({ status: 'exempt', label: '免繳' })
    expect(pick(itemTodo(item({ itemId: 'a', exempt: true, latestVersionNo: 1 }), NOW))).toEqual({ status: 'exempt', label: '免繳' })
  })

  it('補交期限生效、還沒交：截止日用補交期限、膠囊「補交」、late（Q128）', () => {
    const reopenUntil = dayEnd(3)
    const t = itemTodo(item({ itemId: 'a', dueAt: dayEnd(-5), reopenUntil }), NOW)
    expect(t).toMatchObject({ status: 'soon', label: '補交', late: true })
    expect(t.due).toEqual(reopenUntil)
  })

  it('reopenUntil 優先當截止日；期限過了就回到逾期、不是補交', () => {
    const expired = dayEnd(-1)
    const t = itemTodo(item({ itemId: 'a', dueAt: dayEnd(-5), reopenUntil: expired }), NOW)
    expect(t).toMatchObject({ status: 'overdue', label: '逾期', late: false })
    expect(t.due).toEqual(expired)
  })

  it('補交期間交了：已交、不是補交', () => {
    const t = itemTodo(item({ itemId: 'a', dueAt: dayEnd(-5), reopenUntil: dayEnd(3), latestVersionNo: 1 }), NOW)
    expect(t).toMatchObject({ status: 'done', label: '已交', late: false })
  })

  it('連結、整組（Q128）；草稿是隱形的：有草稿還沒交照樣是待交（C 階段規格① §5.2）', () => {
    const t = itemTodo(item({ itemId: 'it-1', hasDraft: true, receiverUnit: 'group', groupCode: 'G07' }), NOW)
    expect(t).toMatchObject({ kind: 'item', id: 'it-1', href: '/dashboard/student/affairs/it-1', status: 'open', label: '待交', unit: 'group' })
    expect(t).not.toHaveProperty('draft')
    expect(pick(itemTodo(item({ itemId: 'a', hasDraft: true, latestVersionNo: 1 }), NOW))).toEqual({ status: 'done', label: '已交' })
  })
})

describe('consentTodo：同意書（Q123）', () => {
  it('輪到你：待你同意、沒有截止日、連到同意書頁', () => {
    const t = consentTodo(consent({ versionId: 'v9', canRespond: true }))
    expect(t).toMatchObject({
      kind: 'consent',
      id: 'v9',
      title: '最終文件授權',
      due: null,
      status: 'open',
      label: '待你同意',
      href: '/dashboard/student/signoff?version=v9',
      unit: null,
      late: false,
    })
  })

  it('連到同意書作業的版本：直接連作業的「狀態」分頁，不繞舊的同意書頁轉址（CL-2）', () => {
    expect(consentTodo(consent({ versionId: 'v9', canRespond: true, itemId: 'it-7' }))!.href).toBe('/dashboard/student/affairs/it-7?tab=status')
    expect(consentTodo(consent({ versionId: 'v9', canRespond: true, itemId: null }))!.href).toBe('/dashboard/student/signoff?version=v9')
  })

  it('表態過：已同意／不同意，都算已完成', () => {
    expect(pick(consentTodo(consent({ voted: 'agree' }))!)).toEqual({ status: 'done', label: '已同意' })
    expect(pick(consentTodo(consent({ voted: 'disagree', state: 'revision' }))!)).toEqual({ status: 'done', label: '退回修正中' })
    expect(pick(consentTodo(consent({ voted: 'disagree', state: 'teacher_pending' }))!)).toEqual({ status: 'done', label: '不同意' })
  })

  it('退回修正中不能表態：已完成、字照 signoffStateLabel', () => {
    expect(pick(consentTodo(consent({ state: 'revision' }))!)).toEqual({ status: 'done', label: '退回修正中' })
  })

  it('輪不到你（等老師、已完成）：已完成、字照 signoffStateLabel', () => {
    expect(pick(consentTodo(consent({ state: 'teacher_pending' }))!)).toEqual({ status: 'done', label: '等待指導老師' })
    expect(pick(consentTodo(consent({ state: 'complete' }))!)).toEqual({ status: 'done', label: '已完成' })
  })

  // AC-ST-27：`isCurrent` 只是簽核包的指標，組員異動或作廢後仍指著失效版本，不能拿它當「有效」。
  it('反例 1：isCurrent 但 superseded（組員變更）、本人已同意 → 不列，不能變成「已同意」卡', () => {
    expect(consentTodo(consent({ isCurrent: true, state: 'superseded', cause: 'member_change', voted: 'agree' }))).toBeNull()
  })

  it('反例 2：isCurrent 但 void（系辦作廢）→ 不列', () => {
    expect(consentTodo(consent({ isCurrent: true, state: 'void', canRespond: false }))).toBeNull()
  })

  it('反例 3：不是目前那一版（isCurrent: false）、即使 complete → 不列', () => {
    expect(consentTodo(consent({ isCurrent: false, state: 'complete', voted: 'agree' }))).toBeNull()
  })

  it('作廢版還在、系辦建了新版：只列新版', () => {
    const todos = buildTodos([], NOW, view(consent({ versionId: 'v1', isCurrent: true, state: 'superseded', voted: 'agree' }), consent({ versionId: 'v2', canRespond: true })))
    expect(todos.map((t) => t.id)).toEqual(['v2'])
    expect(studentOpenCount(todos)).toBe(1)
  })

  // CL-16：連到作業的同意書，作業列本身就在清單裡（狀態在作業的「狀態」分頁），不再多一張同意書卡。
  it('同意書連到清單裡的作業：只留作業列，不重複列同意書卡', () => {
    const todos = buildTodos(
      [item({ itemId: 'ci', kind: 'consent_form' })],
      NOW,
      view(consent({ versionId: 'v2', canRespond: true, itemId: 'ci' })),
    )
    expect(todos.map((t) => `${t.kind}:${t.id}`)).toEqual(['item:ci'])
    expect(studentOpenCount(todos)).toBe(1)
  })

  it('沒連作業的同意書（舊 API 建的包）照舊列卡片', () => {
    const todos = buildTodos([item({ itemId: 'a' })], NOW, view(consent({ versionId: 'v2', canRespond: true, itemId: null })))
    expect(todos.map((t) => `${t.kind}:${t.id}`)).toEqual(['item:a', 'consent:v2'])
  })
})

describe('buildTodos 排序', () => {
  it('未完成在前依截止日、同意書排在有日期的後面；已完成在後、最近送出在前，免繳最後', () => {
    const todos = buildTodos(
      [
        item({ itemId: 'later', dueAt: dayEnd(20) }),
        item({ itemId: 'done-old', dueAt: dayEnd(-9), latestVersionNo: 1, latestReceivedAt: new Date('2026-08-05T10:00:00+08:00') }),
        item({ itemId: 'overdue', dueAt: dayEnd(-2) }),
        item({ itemId: 'exempt', exempt: true, dueAt: dayEnd(1) }),
        item({ itemId: 'soon', dueAt: dayEnd(3) }),
        item({ itemId: 'done-new', dueAt: dayEnd(-1), latestVersionNo: 1, latestReceivedAt: new Date('2026-08-15T10:00:00+08:00') }),
        item({ itemId: 'not-open', opensAt: new Date(NOW.getTime() + 5 * DAY), dueAt: dayEnd(15) }),
      ],
      NOW,
      view(consent({ versionId: 'c-open', canRespond: true })),
    )
    expect(todos.map((t) => t.id)).toEqual(['overdue', 'soon', 'not-open', 'later', 'c-open', 'done-new', 'done-old', 'exempt'])
  })

  it('已表態的同意書照本人表態時間跟已交作業排', () => {
    const todos = buildTodos(
      [item({ itemId: 'done', latestVersionNo: 1, latestReceivedAt: new Date('2026-08-12T10:00:00+08:00') })],
      NOW,
      view(consent({ versionId: 'agreed', voted: 'agree', votedAt: new Date('2026-08-16T10:00:00+08:00') })),
    )
    expect(todos.map((t) => t.id)).toEqual(['agreed', 'done'])
  })
})

// AC-ST-02 的資料：1 件待交（20 天後）、1 件快到期（3 天後）、2 件逾期、1 件已交、1 件尚未開放（5 天後開放）、1 份同意書輪到 S。
const AC_ST_02 = buildTodos(
  [
    item({ itemId: 'open', dueAt: dayEnd(20) }),
    item({ itemId: 'soon', dueAt: dayEnd(3) }),
    item({ itemId: 'overdue-1', dueAt: dayEnd(-2) }),
    item({ itemId: 'overdue-2', dueAt: dayEnd(-6), receiverUnit: 'group', groupCode: 'G07' }),
    item({ itemId: 'done', dueAt: dayEnd(-1), latestVersionNo: 1, latestReceivedAt: new Date('2026-08-15T10:00:00+08:00') }),
    item({ itemId: 'not-open', opensAt: new Date(NOW.getTime() + 5 * DAY), dueAt: dayEnd(25) }),
  ],
  NOW,
  view(consent({ versionId: 'v2', canRespond: true })),
)

describe('數字口徑（AC-ST-02）', () => {
  it('徽章 3（不含逾期、尚未開放：Q117、Q119）；待交篩選 4（含尚未開放）、已交 1、逾期 2', () => {
    expect(studentOpenCount(AC_ST_02)).toBe(3)
    expect(todoCounts(AC_ST_02)).toEqual({ open: 4, done: 1, overdue: 2 })
  })

  it('免繳算已交、不算徽章（AC-ST-13）', () => {
    const todos = buildTodos([item({ itemId: 'x', exempt: true })], NOW, view())
    expect(todoCounts(todos)).toEqual({ open: 0, done: 1, overdue: 0 })
    expect(studentOpenCount(todos)).toBe(0)
  })
})

describe('nextDue', () => {
  it('第一件有截止日、待交／快到期／逾期的（同意書沒有截止日、尚未開放都跳過）', () => {
    expect(nextDue(AC_ST_02)?.id).toBe('overdue-2')
    const noOverdue = AC_ST_02.filter((t) => t.status !== 'overdue')
    expect(nextDue(noOverdue)?.id).toBe('soon')
    expect(nextDue(AC_ST_02.filter((t) => t.kind === 'consent' || t.status === 'notOpen' || t.status === 'done'))).toBeNull()
  })
})

describe('homeTodos（Q124）', () => {
  it('最多 5 張、未完成在前', () => {
    expect(homeTodos(AC_ST_02).map((t) => t.id)).toEqual(['overdue-2', 'overdue-1', 'soon', 'open', 'not-open'])
  })

  it('未完成不足 5 張用最近已交補滿', () => {
    const todos = buildTodos(
      [
        item({ itemId: 'open', dueAt: dayEnd(20) }),
        item({ itemId: 'done-1', latestVersionNo: 1, latestReceivedAt: new Date('2026-08-01T10:00:00+08:00') }),
        item({ itemId: 'done-2', latestVersionNo: 1, latestReceivedAt: new Date('2026-08-16T10:00:00+08:00') }),
      ],
      NOW,
      view(),
    )
    expect(homeTodos(todos).map((t) => pick(t).label)).toEqual(['待交', '已交', '已交'])
    expect(homeTodos(todos).map((t) => t.id)).toEqual(['open', 'done-2', 'done-1'])
    expect(homeTodos(todos, 2)).toHaveLength(2)
    expect(homeTodos([])).toEqual([])
  })
})

describe('studentTodos：讀本人的作業與同意書', () => {
  beforeEach(() => {
    viewer.current = { kind: 'authenticated', userId: 'u-s' }
    myItems.mockReset().mockResolvedValue([item({ itemId: 'open', dueAt: dayEnd(20) })])
    studentView.mockReset().mockResolvedValue(view(consent({ versionId: 'v2', canRespond: true })))
  })

  it('以 userId 讀作業、以這次請求的身分讀同意書，合成一份清單', async () => {
    const todos = await studentTodos('u-s')
    expect(myItems).toHaveBeenCalledWith('u-s')
    expect(studentView).toHaveBeenCalledWith(viewer.current)
    expect(todos.map((t) => t.id)).toEqual(['open', 'v2'])
  })

  it('userId 跟這次請求的身分對不上：不拿別人的身分查同意書', async () => {
    viewer.current = { kind: 'authenticated', userId: 'someone-else' }
    const todos = await studentTodos('u-s')
    expect(studentView).not.toHaveBeenCalled()
    expect(todos.map((t) => t.id)).toEqual(['open'])
  })
})
