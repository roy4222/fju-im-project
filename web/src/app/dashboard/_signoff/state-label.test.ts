import { describe, expect, it } from 'vitest'
import { newerVersionNo, signoffStateLabel } from '@/app/dashboard/_signoff/state-label'

describe('同意書狀態徽章（W13c review）', () => {
  it('被取代但還沒有新版：寫已作廢＋原因，不說「已被新版取代」', () => {
    expect(signoffStateLabel('superseded', { cause: 'advisor_change', newerVersionNo: null })).toBe('已作廢（指導老師變更）')
    expect(signoffStateLabel('superseded', { cause: 'member_change' })).toBe('已作廢（組員變更）')
    expect(signoffStateLabel('superseded')).toBe('已作廢')
  })

  it('已經有新版：寫已被第 N 版取代', () => {
    expect(signoffStateLabel('superseded', { cause: 'content_change', newerVersionNo: 2 })).toBe('已被第 2 版取代')
  })

  it('其他狀態照原本的字', () => {
    expect(signoffStateLabel('collecting')).toBe('收集學生同意中')
    expect(signoffStateLabel('void', { cause: 'x' })).toBe('已作廢')
  })

  it('找比這一版新的第一版', () => {
    const history = [{ versionNo: 1 }, { versionNo: 3 }, { versionNo: 2 }]
    expect(newerVersionNo(1, history)).toBe(2)
    expect(newerVersionNo(3, history)).toBeNull()
  })
})
