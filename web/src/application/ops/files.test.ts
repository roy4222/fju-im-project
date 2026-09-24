import { describe, expect, it } from 'vitest'
import {
  checkDeclaredUpload,
  contentDispositionFor,
  createContentInspector,
  effectiveMaxBytes,
  extensionOf,
  sanitizeDisplayName,
  storageKeyFor,
  tempKeyFor,
  type FileTypeId,
  type UploadRules,
} from '@/application/ops/files'

const csvRules: UploadRules = { purpose: 'roster_csv', allowedTypes: ['csv'], maxBytes: 2 * 1024 * 1024, scope: { kind: 'global' } }
const MiB = 1024 * 1024

function inspect(type: FileTypeId, ...chunks: (string | number[])[]) {
  const inspector = createContentInspector(type)
  for (const chunk of chunks) {
    inspector.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk))
  }
  return inspector.finish()
}

describe('副檔名與宣告類型（第一關）', () => {
  it('副檔名不在白名單就拒絕，不管宣告的 MIME', () => {
    expect(checkDeclaredUpload({ fileName: 'virus.exe', declaredMime: 'text/csv' }, csvRules, 100 * MiB)).toMatchObject({
      ok: false,
      code: 'FILE_TYPE_REJECTED',
    })
    expect(checkDeclaredUpload({ fileName: 'roster.csv.exe', declaredMime: 'text/csv' }, csvRules, 100 * MiB)).toMatchObject({
      ok: false,
      code: 'FILE_TYPE_REJECTED',
    })
  })

  it('CSV 接受瀏覽器常見的幾種宣告（Excel 在 Windows 會給 vnd.ms-excel）', () => {
    for (const mime of ['text/csv', 'text/plain', 'application/vnd.ms-excel', 'application/octet-stream', '']) {
      expect(checkDeclaredUpload({ fileName: '名單.CSV', declaredMime: mime }, csvRules, 100 * MiB)).toMatchObject({
        ok: true,
        type: 'csv',
        extension: 'csv',
      })
    }
  })

  it('宣告成可執行檔的 .csv 拒絕', () => {
    expect(
      checkDeclaredUpload({ fileName: 'a.csv', declaredMime: 'application/x-msdownload' }, csvRules, 100 * MiB),
    ).toMatchObject({ ok: false, code: 'FILE_TYPE_REJECTED' })
  })

  it('宣告大小超過上限就先擋；空檔也擋', () => {
    expect(checkDeclaredUpload({ fileName: 'a.csv', declaredMime: 'text/csv', declaredSize: 3 * MiB }, csvRules, 100 * MiB)).toMatchObject({
      ok: false,
      code: 'FILE_TOO_LARGE',
    })
    expect(checkDeclaredUpload({ fileName: 'a.csv', declaredMime: 'text/csv', declaredSize: 0 }, csvRules, 100 * MiB)).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    })
  })

  it('單檔上限＝環境與用途取小（模組 10 §11.2）', () => {
    expect(effectiveMaxBytes(20 * MiB, 100 * MiB)).toBe(20 * MiB)
    expect(effectiveMaxBytes(200 * MiB, 100 * MiB)).toBe(100 * MiB)
    expect(checkDeclaredUpload({ fileName: 'a.csv', declaredMime: 'text/csv', declaredSize: MiB + 1 }, csvRules, MiB)).toMatchObject({
      ok: false,
      code: 'FILE_TOO_LARGE',
    })
  })

  it('副檔名取最後一段、忽略大小寫、路徑不影響', () => {
    expect(extensionOf('../../x/Roster.CSV')).toBe('csv')
    expect(extensionOf('.csv')).toBe('')
    expect(extensionOf('noext')).toBe('')
  })
})

describe('內容檢查（看內容，不只看副檔名）', () => {
  it('正常的 UTF-8 CSV 通過（含 BOM、中文、Tab、CRLF）', () => {
    expect(inspect('csv', '\ufeffstudent_no,name\r\n', '411,王小明\t\n')).toEqual({ ok: true })
  })

  it('.exe 改名成 .csv：MZ 開頭被擋', () => {
    expect(inspect('csv', [0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00])).toMatchObject({ ok: false })
  })

  it('PDF、ZIP（含 xlsx）、PNG、JPEG、舊版 Excel 改名成 .csv 都被擋', () => {
    expect(inspect('csv', '%PDF-1.7\n%âãÏÓ')).toMatchObject({ ok: false })
    expect(inspect('csv', [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])).toMatchObject({ ok: false })
    expect(inspect('csv', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).toMatchObject({ ok: false })
    expect(inspect('csv', [0xff, 0xd8, 0xff, 0xe0])).toMatchObject({ ok: false })
    expect(inspect('csv', [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1])).toMatchObject({ ok: false })
  })

  it('含 NUL 或其他控制字元的不是文字檔', () => {
    expect(inspect('csv', 'a,b\n', [0x00], 'c')).toMatchObject({ ok: false })
    expect(inspect('csv', 'a\u0007b')).toMatchObject({ ok: false })
  })

  it('不是合法 UTF-8（例如 Big5 存的檔）被擋，包含被切在兩塊之間的字', () => {
    expect(inspect('csv', [0xa4, 0xa4, 0xa4, 0xe5])).toMatchObject({ ok: false })
    // 「王」= E7 8E 8B，切成兩塊送進來仍然合法。
    expect(inspect('csv', [0x61, 0xe7], [0x8e, 0x8b])).toEqual({ ok: true })
    // 結尾停在半個字上：不合法。
    expect(inspect('csv', [0x61, 0xe7, 0x8e])).toMatchObject({ ok: false })
  })

  it('開頭是「MZ」的正常文字不會被誤判成執行檔', () => {
    expect(inspect('csv', 'MZ,name\n1,王')).toEqual({ ok: true })
  })

  it('有簽章的類型：簽章對才通過', () => {
    expect(inspect('pdf', '%PDF-1.4\n')).toEqual({ ok: true })
    expect(inspect('pdf', [0x4d, 0x5a, 0x90, 0x00])).toMatchObject({ ok: false })
    expect(inspect('png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])).toEqual({ ok: true })
    expect(inspect('xlsx', [0x50, 0x4b, 0x03, 0x04])).toEqual({ ok: true })
  })
})

describe('檔名與路徑', () => {
  it('顯示名稱去掉路徑、控制字元、雙向控制符，不能變成隱藏檔', () => {
    expect(sanitizeDisplayName('../../etc/passwd')).toBe('passwd')
    expect(sanitizeDisplayName('C:\\Users\\a\\名單.csv')).toBe('名單.csv')
    expect(sanitizeDisplayName('a\u0000b\r\n.csv')).toBe('ab.csv')
    expect(sanitizeDisplayName('invoice\u202Evsc.exe')).toBe('invoicevsc.exe')
    expect(sanitizeDisplayName('..')).toBe('file')
    expect(sanitizeDisplayName('.htaccess')).toBe('htaccess')
    expect(sanitizeDisplayName('a"b<c>.csv')).toBe('a_b_c_.csv')
  })

  it('太長的檔名截斷但保留副檔名', () => {
    const name = sanitizeDisplayName(`${'名'.repeat(300)}.csv`)
    expect(name.length).toBeLessThanOrEqual(150)
    expect(name.endsWith('.csv')).toBe(true)
  })

  it('storage key 只由日期與檔案 ID 組成，不含原始檔名；ID 格式不對直接丟錯', () => {
    const id = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
    expect(storageKeyFor(id, new Date('2026-09-24T00:00:00Z'))).toBe(`files/2026/09/${id}`)
    expect(tempKeyFor(id)).toBe(`tmp/${id}`)
    expect(() => storageKeyFor('../../etc/passwd', new Date())).toThrow()
    expect(() => tempKeyFor('x/../../y')).toThrow()
  })

  it('Content-Disposition 一律 attachment，中文走 filename*，引號與換行不會注入標頭', () => {
    expect(contentDispositionFor('名單 v4.csv')).toBe(
      `attachment; filename="__ v4.csv"; filename*=UTF-8''%E5%90%8D%E5%96%AE%20v4.csv`,
    )
    const tricky = contentDispositionFor('a"\r\nSet-Cookie: x=1;.csv')
    expect(tricky).not.toMatch(/[\r\n]/)
    expect(tricky.startsWith('attachment; filename="')).toBe(true)
    expect(tricky).toContain("filename*=UTF-8''")
  })
})
