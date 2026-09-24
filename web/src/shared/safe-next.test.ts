import { describe, expect, it } from 'vitest'
import { safeNextPath } from '@/shared/safe-next'

describe('safeNextPath：登入後的 next 只接受站內相對路徑（PR #210 合併 review）', () => {
  it.each([
    ['/dashboard', '/dashboard'],
    ['/dashboard/admin?x=1', '/dashboard/admin?x=1'],
    ['/account/change-password', '/account/change-password'],
    ['/', '/'],
    ['/dashboard/../account', '/account'],
  ])('接受站內路徑 %s', (raw, expected) => {
    expect(safeNextPath(raw)).toBe(expected)
  })

  it.each([
    ['protocol-relative', '//evil.com'],
    ['反斜線', '/\\evil.com'],
    ['反斜線＋斜線', '/\\/evil.com'],
    ['%5C 編碼', '/%5Cevil.com'],
    ['%5C%5C 編碼', '/%5C%5Cevil.com'],
    ['%2F 編碼', '/%2Fevil.com'],
    ['整串編碼', '%2F%5Cevil.com'],
    ['絕對網址', 'https://evil.com'],
    ['javascript:', 'javascript:alert(1)'],
    ['沒有斜線的網域', 'evil.com'],
    ['tab 夾在前面', '/\t/evil.com'],
    ['tab 後接反斜線', '/\t\\evil.com'],
    ['換行', '/dash\nboard'],
    ['換行後接網域', '/\n/evil.com'],
    ['%0A 編碼的換行', '/%0A/evil.com'],
    ['%09 編碼的 tab', '/%09/evil.com'],
    ['開頭空白', ' /dashboard'],
    ['壞掉的百分比編碼', '/%E0%A4%A'],
    ['空字串', ''],
    // 第 2 次合併 review：原字串過得了前綴檢查，正規化後卻變成 `//evil.com`
    ['點段接雙斜線', '/.//evil.com'],
    ['雙點段接雙斜線', '/..//evil.com'],
    ['%2e 點段', '/%2e//evil.com'],
    ['%2E%2E 雙點段', '/%2E%2E//evil.com'],
    ['路徑中間的 .. 退回根', '/dashboard/..//evil.com'],
    ['反斜線 .. 反斜線', '/a\\..\\..\\\\evil.com'],
    ['反斜線 .. 雙斜線', '/a\\..//evil.com'],
    ['點段接反斜線', '/./\\evil.com'],
  ])('拒絕 %s（%j）', (_label, raw) => {
    expect(safeNextPath(raw)).toBeNull()
  })

  it('任何被接受的回傳值都不以 // 或 /\\ 開頭，且再丟回去原樣通過', () => {
    const inputs = [
      '/dashboard',
      '/dashboard/admin?x=1',
      '/dashboard/../account',
      '/日本',
      '/a?b= ',
      '/a%25b',
      '/.//evil.com',
      '/..//evil.com',
      '/%2e//evil.com',
      '/dashboard/..//evil.com',
      '/a\\..\\..\\\\evil.com',
      '/./\\evil.com',
    ]
    for (const raw of inputs) {
      const out = safeNextPath(raw)
      if (out === null) continue
      expect(out).not.toMatch(/^\/[/\\]/)
      expect(safeNextPath(out)).toBe(out)
    }
  })

  it('非字串（例如 searchParams 的陣列）一律拒絕', () => {
    expect(safeNextPath(undefined)).toBeNull()
    expect(safeNextPath(['/dashboard'])).toBeNull()
  })
})
