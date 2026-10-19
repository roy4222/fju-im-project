import { describe, expect, it } from 'vitest'
import {
  cooldownEndsAt,
  cooldownMessage,
  describeCooldown,
  describeGradingReminder,
  describeItemReminder,
  describeOverdueReminder,
  gradingReminderTitle,
  itemReminderTitle,
  nextAllowedAt,
  pendingReceiverIds,
  relativeAgo,
  teachersBehind,
  type ReminderReceiver,
} from '@/application/reminders'

/** C1-05：催繳的純規則（C 階段規格① §1.5、§3.5、§8；AC-12、AC-34 的文案與冷卻）。 */

const NOW = new Date('2026-11-16T02:00:00Z') // 臺北 10:00

describe('冷卻：同一份作業（評分：同一屆）24 小時只能催一次', () => {
  it('沒催過：現在就可以', () => {
    expect(nextAllowedAt(null, NOW)).toBeNull()
  })

  it('1 小時前催過：要等到上次之後滿 24 小時', () => {
    const last = new Date(NOW.getTime() - 3_600_000)
    expect(nextAllowedAt(last, NOW)).toEqual(new Date('2026-11-17T01:00:00Z'))
  })

  it('剛好滿 24 小時：可以再催', () => {
    expect(nextAllowedAt(new Date(NOW.getTime() - 86_400_000), NOW)).toBeNull()
    expect(nextAllowedAt(new Date(NOW.getTime() - 86_399_999), NOW)).not.toBeNull()
  })

  it('這次催完的下一次＝明天同一時間', () => {
    expect(cooldownEndsAt(NOW)).toEqual(new Date('2026-11-17T02:00:00Z'))
  })

  it('CONFLICT 句子：「{標題}上次催繳在 {時間}，24 小時內不能再催」', () => {
    expect(cooldownMessage('「期中報告」', NOW, cooldownEndsAt(NOW))).toBe(
      '「期中報告」上次催繳在 2026/11/16 10:00，24 小時內不能再催（2026/11/17 10:00 之後可以）。',
    )
  })

  it('按鈕字樣：剛按完是「上次催繳剛剛，{明天同一時間} 後可再催」；3 小時前', () => {
    expect(describeCooldown(NOW, cooldownEndsAt(NOW), new Date(NOW.getTime() + 5_000))).toBe('上次催繳剛剛，2026/11/17 10:00 後可再催')
    const last = new Date(NOW.getTime() - 3 * 3_600_000)
    expect(describeCooldown(last, cooldownEndsAt(last), NOW)).toBe('上次催繳3 小時前，2026/11/17 07:00 後可再催')
    expect(relativeAgo(new Date(NOW.getTime() - 25 * 60_000), NOW)).toBe('25 分鐘前')
  })
})

describe('通知標題', () => {
  it('作業：「{標題} 尚未繳交，截止 {時間}」；沒有截止只說尚未繳交', () => {
    expect(itemReminderTitle('期中報告', new Date('2026-11-15T15:59:00Z'))).toBe('期中報告 尚未繳交，截止 2026/11/15 23:59')
    expect(itemReminderTitle('期中結果確認', null)).toBe('期中結果確認 尚未繳交')
  })

  it('評分：「您還有 N 份評分未送出」', () => {
    expect(gradingReminderTitle(2)).toBe('您還有 2 份評分未送出')
  })
})

describe('要催誰', () => {
  const r = (receiverId: string, patch: Partial<ReminderReceiver> = {}): ReminderReceiver => ({
    receiverId,
    current: true,
    submitted: false,
    overdue: true,
    ...patch,
  })
  const receivers = [
    r('done', { submitted: true }),
    r('late'),
    r('open', { overdue: false }),
    r('exempt-or-removed', { current: false }),
  ]

  it('作業頁：目前名單上還沒正式送出的都催（不含免填、移出、已交）', () => {
    expect(pendingReceiverIds(receivers, { scope: 'all', consent: false })).toEqual(['late', 'open'])
  })

  it('首頁逾期卡：只催逾期未繳的（補交期限還沒到的不算逾期）', () => {
    expect(pendingReceiverIds(receivers, { scope: 'overdue', consent: false })).toEqual(['late'])
  })

  it('站內同意書：完成看簽核包不看繳交版本，名單上的組都要去看包', () => {
    expect(pendingReceiverIds(receivers, { scope: 'all', consent: true })).toEqual(['done', 'late', 'open'])
    expect(pendingReceiverIds(receivers, { scope: 'overdue', consent: true })).toEqual(['done', 'late'])
  })

  it('評分：只有 counted < assigned 的老師，各自還差幾份', () => {
    expect(
      teachersBehind([
        { teacherUserId: 'b', assigned: 3, counted: 1 },
        { teacherUserId: 'c', assigned: 2, counted: 2 },
        { teacherUserId: 'a', assigned: 1, counted: 0 },
      ]),
    ).toEqual([
      { teacherUserId: 'a', pending: 1 },
      { teacherUserId: 'b', pending: 2 },
    ])
  })
})

describe('回饋句子（AC-12、AC-34）', () => {
  it('催一份作業：「已通知 3 人」', () => {
    expect(describeItemReminder({ notified: 3 })).toBe('已通知 3 人')
  })

  it('逾期卡：有略過的才加括號', () => {
    expect(describeOverdueReminder({ notified: 12, items: [{ skippedCooldown: false }, { skippedCooldown: true }] })).toBe(
      '已通知 12 人（1 份作業 24 小時內催過，略過）',
    )
    expect(describeOverdueReminder({ notified: 4, items: [{ skippedCooldown: false }] })).toBe('已通知 4 人')
  })

  it('評分卡：「已通知 2 位老師」', () => {
    expect(describeGradingReminder({ notified: 2 })).toBe('已通知 2 位老師')
  })
})
