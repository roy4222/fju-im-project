import { describe, expect, it } from 'vitest'
import { uploadRateMax } from '@/composition/files'

/** SH-B10：上傳限速上限可用 `UPLOAD_RATE_MAX` 蓋掉；打錯值退回契約 03 §6 的 20 次。 */
describe('uploadRateMax', () => {
  it('沒設就是 20', () => {
    expect(uploadRateMax({})).toBe(20)
    expect(uploadRateMax({ UPLOAD_RATE_MAX: '' })).toBe(20)
  })

  it('正整數照用', () => {
    expect(uploadRateMax({ UPLOAD_RATE_MAX: '1000' })).toBe(1000)
    expect(uploadRateMax({ UPLOAD_RATE_MAX: ' 5 ' })).toBe(5)
  })

  it('不是正整數就退回 20，不會變成永遠放行或全擋', () => {
    for (const value of ['abc', '0', '-3', '2.5', '1e3', 'Infinity', '99999999999999999999']) {
      expect(uploadRateMax({ UPLOAD_RATE_MAX: value }), value).toBe(20)
    }
  })
})
