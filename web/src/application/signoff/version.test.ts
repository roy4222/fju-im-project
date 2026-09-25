import { describe, expect, it } from 'vitest'
import {
  buildParticipants,
  causeForNewVersion,
  describeCause,
  freezeAuthorizationScope,
  hasVisibleText,
  isTerminal,
  scopeContent,
  type DraftSnapshot,
  type StudentParticipant,
} from '@/application/signoff/version'

const student = (n: number, studentNo: string | null = `41100000${n}`): StudentParticipant => ({
  userId: `u${n}`,
  displayName: `學生${n}`,
  studentNo,
  membershipId: `m${n}`,
})
const advisor = { userId: 't1', displayName: '王老師', assignmentId: 'a1' }

describe('參與者快照（產品「參與者版本與失效」、SGN-07）', () => {
  it('人數照實際有效成員：三人組就三人，依學號排序；主指導含指派 id', () => {
    const built = buildParticipants([student(3), student(1), student(2)], advisor, 'G03')
    expect(built).toEqual({
      ok: true,
      value: { students: [student(1), student(2), student(3)], advisor },
    })
  })

  it('沒有組員或沒有主指導不能建版，訊息說出是哪一組、下一步', () => {
    expect(buildParticipants([], advisor, 'G01')).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    const noAdvisor = buildParticipants([student(1)], null, 'G02')
    expect(noAdvisor).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(noAdvisor.ok ? '' : noAdvisor.message).toMatch(/G02.*主指導/)
  })
})

describe('授權範圍凍結（RR06）', () => {
  const draft: DraftSnapshot = {
    entryId: 'e1',
    revision: 4,
    title: '智慧校園導覽',
    summary: '用室內定位帶新生認識校園。',
    summaryChecksum: 'c'.repeat(64),
    videoUrl: 'https://youtu.be/x',
    poster: { fileId: 'f1', checksum: 'p'.repeat(64), name: 'poster.png' },
  }

  it('範圍＝草稿當下的題目、摘要（原文與 checksum）、海報版本、影片連結、用途；記來源條目、草稿版本與內容雜湊', () => {
    expect(freezeAuthorizationScope(draft, 'h'.repeat(64), 'G01')).toEqual({
      ok: true,
      value: {
        usages: ['public_showcase'],
        title: '智慧校園導覽',
        summary: '用室內定位帶新生認識校園。',
        summaryChecksum: 'c'.repeat(64),
        assets: [{ fileId: 'f1', checksum: 'p'.repeat(64), kind: 'poster', name: 'poster.png' }],
        videoUrl: 'https://youtu.be/x',
        validUntil: null,
        scopeSource: { entryId: 'e1', draftRevision: 4, contentHash: 'h'.repeat(64) },
      },
    })
  })

  it('沒有海報就是空的素材清單；題目或摘要空白不能凍結', () => {
    const noPoster = freezeAuthorizationScope({ ...draft, poster: null }, 'h', 'G01')
    expect(noPoster.ok && noPoster.value.assets).toEqual([])
    expect(freezeAuthorizationScope({ ...draft, title: '  ' }, 'h', 'G01')).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(freezeAuthorizationScope({ ...draft, summary: '' }, 'h', 'G01')).toMatchObject({ ok: false })
  })

  it('內容雜湊的依據只看會公開的東西：換草稿版本號不影響，換海報、摘要會影響', () => {
    expect(scopeContent({ ...draft, revision: 9 })).toEqual(scopeContent(draft))
    expect(scopeContent({ ...draft, poster: { ...draft.poster!, checksum: 'q'.repeat(64) } })).not.toEqual(scopeContent(draft))
    expect(scopeContent({ ...draft, summaryChecksum: 'd'.repeat(64) })).not.toEqual(scopeContent(draft))
  })
})

describe('新版的建版原因與終點狀態', () => {
  it('第一版 null；上一版因組員／主指導變更或重置失效就沿用；其他（還在收、完成、退回）是內容變更', () => {
    expect(causeForNewVersion(null)).toBeNull()
    expect(causeForNewVersion({ state: 'superseded', cause: 'member_change' })).toBe('member_change')
    expect(causeForNewVersion({ state: 'superseded', cause: 'advisor_change' })).toBe('advisor_change')
    expect(causeForNewVersion({ state: 'collecting', cause: null })).toBe('content_change')
    expect(causeForNewVersion({ state: 'complete', cause: null })).toBe('content_change')
    expect(causeForNewVersion({ state: 'revision', cause: '附件錯了' })).toBe('content_change')
  })

  it('失效與作廢不再收票；原因代碼翻成中文，管理員理由原樣顯示', () => {
    expect(isTerminal('superseded')).toBe(true)
    expect(isTerminal('void')).toBe(true)
    expect(isTerminal('collecting')).toBe(false)
    expect(describeCause('member_change')).toBe('組員變更')
    expect(describeCause('附件放錯')).toBe('附件放錯')
    expect(describeCause(null)).toBeNull()
  })
})

describe('全文有沒有字', () => {
  it('空段落、只有空白與 &nbsp; 算空', () => {
    expect(hasVisibleText('<p> </p><p>&nbsp;</p>')).toBe(false)
    expect(hasVisibleText('')).toBe(false)
    expect(hasVisibleText('<p>同意</p>')).toBe(true)
  })
})
