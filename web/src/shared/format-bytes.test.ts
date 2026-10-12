import { describe, expect, it } from 'vitest'
import { formatBytes } from '@/shared/format-bytes'

describe('formatBytes：全站容量顯示同一套（第三波 W5；§10 MiB／KiB 改 MB／KB）', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1023, '1023 B'],
    [1024, '1 KB'],
    [1536, '1.5 KB'],
    [1048576, '1 MB'],
    [2.5 * 1024 * 1024, '2.5 MB'],
    [1024 ** 3, '1 GB'],
    [1.25 * 1024 ** 3, '1.3 GB'],
    [1024 ** 4, '1 TB'],
    [5 * 1024 ** 5, '5120 TB'],
  ])('%d 位元組 → %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected)
  })

  it('四捨五入到下一個單位時就換單位，不寫「1024 KB」', () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe('1 MB')
    expect(formatBytes(1024 ** 3 - 1)).toBe('1 GB')
  })

  it.each([[-1], [Number.NaN], [Number.POSITIVE_INFINITY]])('不是合理的位元組數（%d）顯示「—」', (bytes) => {
    expect(formatBytes(bytes)).toBe('—')
  })
})
