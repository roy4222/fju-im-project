import { describe, expect, it } from 'vitest'
import {
  BIO_MAX_LENGTH,
  normalizeProfileCard,
  SKILL_MAX_COUNT,
  SKILL_MAX_LENGTH,
  SKILL_PRESETS,
  textLength,
} from '@/application/accounts/profile-card'

/** C3-07：名片字數與技能上限（C3 設計方案 §4.1、§4.3；AC-C3-07）。 */

const base = { bio: '做過三個 Next.js 專案', skills: ['前端', '資料庫'], contactEmail: 'a@example.com', openToJoin: true }

describe('normalizeProfileCard', () => {
  it('去前後空白、Email 轉小寫；技能保留順序', () => {
    const result = normalizeProfileCard({ ...base, bio: '  做過三個 Next.js 專案  ', contactEmail: ' A@Example.com ', skills: ['前端', ' Figma '] })
    expect(result).toEqual({
      ok: true,
      value: { bio: '做過三個 Next.js 專案', skills: ['前端', 'Figma'], contactEmail: 'a@example.com', openToJoin: true },
    })
  })

  it('(a) 自介 51 字被擋，50 字可以；中文、emoji 都算一個字', () => {
    expect(normalizeProfileCard({ ...base, bio: '字'.repeat(50) }).ok).toBe(true)
    expect(normalizeProfileCard({ ...base, bio: '😀'.repeat(50) }).ok).toBe(true)
    expect(normalizeProfileCard({ ...base, bio: '😀'.repeat(51) })).toMatchObject({ ok: false, details: { field: 'bio' } })
    const tooLong = normalizeProfileCard({ ...base, bio: '字'.repeat(51) })
    expect(tooLong).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', message: '自介最多 50 字。', details: { field: 'bio' } })
  })

  it('自介可以空白；不收換行等控制字元', () => {
    expect(normalizeProfileCard({ ...base, bio: '' })).toMatchObject({ ok: true, value: { bio: '' } })
    expect(normalizeProfileCard({ ...base, bio: '第一行\n第二行' })).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
  })

  it('(b) 第 9 個技能被擋', () => {
    const eight = SKILL_PRESETS.slice(0, 8)
    expect(normalizeProfileCard({ ...base, skills: [...eight] }).ok).toBe(true)
    expect(normalizeProfileCard({ ...base, skills: [...eight, '自訂'] })).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
      message: '最多 8 個技能。',
      details: { field: 'skills' },
    })
  })

  it('(c) 去空白後重複的技能只留一個、不報錯；空字串略過', () => {
    const eight = SKILL_PRESETS.slice(0, 8)
    expect(normalizeProfileCard({ ...base, skills: ['前端', ' 前端 ', '', '   '] })).toMatchObject({ ok: true, value: { skills: ['前端'] } })
    // 重複的不算數：8 個加一個重複的仍然可以。
    expect(normalizeProfileCard({ ...base, skills: [...eight, ` ${eight[0]} `] })).toMatchObject({ ok: true, value: { skills: eight } })
  })

  it('(d) 13 字的技能被擋，12 字可以', () => {
    expect(normalizeProfileCard({ ...base, skills: ['一'.repeat(12)] }).ok).toBe(true)
    expect(normalizeProfileCard({ ...base, skills: ['一'.repeat(13)] })).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
      message: '每個技能最多 12 字。',
      details: { field: 'skills' },
    })
  })

  it('Email 沿用註冊的規則：空的、格式錯都擋', () => {
    expect(normalizeProfileCard({ ...base, contactEmail: '' })).toMatchObject({ ok: false, message: '請填聯絡 Email。' })
    expect(normalizeProfileCard({ ...base, contactEmail: 'not-mail' })).toMatchObject({ ok: false, message: '聯絡 Email的格式不對。' })
  })

  it('常數與規格一致', () => {
    expect([BIO_MAX_LENGTH, SKILL_MAX_COUNT, SKILL_MAX_LENGTH]).toEqual([50, 8, 12])
    expect(SKILL_PRESETS).toEqual(['前端', '後端', '資料庫', '資料分析', 'AI', 'UI 設計', '簡報', '企劃', 'Python', 'JavaScript', 'Figma'])
    expect(textLength('😀前端')).toBe(3)
  })
})
