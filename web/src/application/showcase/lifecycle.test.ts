import { describe, expect, it } from 'vitest'
import {
  checkShowcaseLifecycle,
  normalizeAward,
  SHOWCASE_STATUS_LABEL,
  type ShowcaseLifecycleAction,
  type ShowcaseStatus,
} from '@/application/showcase/lifecycle'

const allowed = (action: ShowcaseLifecycleAction, status: ShowcaseStatus) => checkShowcaseLifecycle(action, status) === null

describe('優秀專題生命週期（W2）', () => {
  it('發布只從草稿；下架只從公開中；重新發布只從已下架', () => {
    expect(allowed('publish', 'draft')).toBe(true)
    expect(allowed('publish', 'published')).toBe(false)
    expect(allowed('publish', 'withdrawn')).toBe(false)
    expect(allowed('withdraw', 'published')).toBe(true)
    expect(allowed('withdraw', 'draft')).toBe(false)
    expect(allowed('withdraw', 'withdrawn')).toBe(false)
    expect(allowed('republish', 'withdrawn')).toBe(true)
    expect(allowed('republish', 'draft')).toBe(false)
    expect(allowed('republish', 'published')).toBe(false)
  })

  it('刪除只限草稿與已下架；公開中要先下架（說得出原因）', () => {
    expect(allowed('delete', 'draft')).toBe(true)
    expect(allowed('delete', 'withdrawn')).toBe(true)
    expect(checkShowcaseLifecycle('delete', 'published')).toMatch(/先按「下架」/)
  })

  it('不能做時的原因是中文、提到現在的狀態', () => {
    expect(checkShowcaseLifecycle('withdraw', 'draft')).toContain('草稿')
    expect(checkShowcaseLifecycle('publish', 'withdrawn')).toContain('重新發布')
  })

  it('狀態顯示字：草稿／公開中／已下架', () => {
    expect(SHOWCASE_STATUS_LABEL).toEqual({ draft: '草稿', published: '公開中', withdrawn: '已下架' })
  })
})

describe('獎項', () => {
  it('沒選等級＝拿掉獎項，名稱一起清掉', () => {
    expect(normalizeAward({ level: '', label: '' })).toEqual({ ok: true, value: { level: null, label: null } })
    expect(normalizeAward({ level: null, label: null })).toEqual({ ok: true, value: { level: null, label: null } })
  })

  it('優秀專題、佳作；名稱選填、去頭尾空白', () => {
    expect(normalizeAward({ level: 'excellent', label: '  第 43 屆專題競賽第一名 ' })).toEqual({
      ok: true,
      value: { level: 'excellent', label: '第 43 屆專題競賽第一名' },
    })
    expect(normalizeAward({ level: 'merit', label: '' })).toEqual({ ok: true, value: { level: 'merit', label: null } })
  })

  it('不認得的等級、沒選等級卻填名稱、名稱超過 100 字都擋下', () => {
    expect(normalizeAward({ level: 'gold', label: '' }).ok).toBe(false)
    const orphan = normalizeAward({ level: '', label: '佳作' })
    expect(orphan.ok === false && orphan.message).toContain('先選獎項')
    expect(normalizeAward({ level: 'merit', label: '字'.repeat(101) }).ok).toBe(false)
    expect(normalizeAward({ level: 'merit', label: '字'.repeat(100) }).ok).toBe(true)
  })
})
