import { describe, expect, it } from 'vitest'
import { adminHeroCta } from '@/app/dashboard/admin/home-cta'

describe('系辦首頁歡迎列按鈕', () => {
  it('還沒有屆別：給「前往屆別設定」連到屆別頁', () => {
    expect(adminHeroCta({ cohort: null, position: null }, 3)).toEqual({ href: '/dashboard/admin/cohorts', label: '前往屆別設定' })
  })

  it('有屆別但還沒排階段：一樣先去屆別頁（歡迎列那句也是這樣說）', () => {
    expect(adminHeroCta({ cohort: { id: 'c' }, position: null }, 0)).toEqual({ href: '/dashboard/admin/cohorts', label: '前往屆別設定' })
  })

  it('屆別與階段都設好：審核帳號，帶待審數', () => {
    expect(adminHeroCta({ cohort: { id: 'c' }, position: { kind: 'in_stage' } }, 2)).toEqual({
      href: '/dashboard/admin/accounts?status=pending',
      label: '審核帳號（2）',
    })
  })
})
