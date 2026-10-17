import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileDownload } from '@/application/ops'

// 授權換成假的；拒絕回應、快取標頭與 304 用真的共用規則（跟下載路由同一份）。授權本身在 file-storage 的整合測試。
const downloadFile = vi.fn()
vi.mock('@/composition/files', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/composition/files')>()),
  downloadFile: (...args: unknown[]) => downloadFile(...args),
}))

const { GET } = await import('./route')
const { GET: DOWNLOAD } = await import('../route')

const ID = '01890000-0000-7000-8000-000000000001'
const CHECKSUM = 'b'.repeat(64)

function receipt(overrides: Partial<FileDownload> = {}): FileDownload {
  return {
    fileId: ID,
    purpose: 'submission',
    originalName: '期末報告.pdf',
    sizeBytes: 3,
    mime: 'application/pdf',
    checksum: CHECKSUM,
    publicRead: false,
    body: new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3]))
        c.close()
      },
    }),
    ...overrides,
  }
}

const ctx = { params: Promise.resolve({ id: ID }) }
const preview = (headers: Record<string, string> = {}, method = 'GET') =>
  GET(new Request(`http://localhost/api/files/${ID}/preview`, { headers, method }), { params: Promise.resolve({ id: ID }) })
const download = (headers: Record<string, string> = {}) => DOWNLOAD(new Request(`http://localhost/api/files/${ID}`, { headers }), ctx)

describe('GET /api/files/[id]/preview（A-06）', () => {
  beforeEach(() => downloadFile.mockReset())

  it('PDF：200、inline、只讓本站嵌入（frame-ancestors self＋SAMEORIGIN）、nosniff、不加 sandbox（spike）', async () => {
    downloadFile.mockResolvedValue({ ok: true, receipt: receipt() })
    const response = await preview()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(response.headers.get('content-disposition')).toMatch(/^inline; filename="____\.pdf"; filename\*=UTF-8''/)
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'self'")
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('etag')).toBeNull()
    expect(response.headers.get('content-length')).toBe('3')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    // 跟下載路由同一個授權函式、同樣的參數（每次請求都重新授權）。
    expect(downloadFile).toHaveBeenCalledWith(expect.any(Headers), ID)
  })

  it.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])('圖片 %s：inline，CSP 保留 sandbox', async (mime) => {
    downloadFile.mockResolvedValue({ ok: true, receipt: receipt({ mime, originalName: 'shot.png' }) })
    const response = await preview()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(mime)
    expect(response.headers.get('content-disposition')).toMatch(/^inline;/)
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'self'; sandbox")
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN')
  })

  it.each([
    'image/svg+xml',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/csv',
    'text/html',
    'application/zip',
    'application/octet-stream',
  ])('%s：不內嵌，302 回下載路由（no-store）、串流已取消、沒有內容', async (mime) => {
    const r = receipt({ mime })
    const cancel = vi.spyOn(r.body, 'cancel')
    downloadFile.mockResolvedValue({ ok: true, receipt: r })
    const response = await preview()
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(`/api/files/${ID}`)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('content-disposition')).toBeNull()
    expect(cancel).toHaveBeenCalled()
    expect(await response.text()).toBe('')
  })

  it('拒絕與下載路由逐項相同（狀態、標頭、內容）；瀏覽器直接開沒登入時，登入後回到預覽', async () => {
    const failures = [
      { ok: false, code: 'UNAUTHENTICATED', message: '請先登入。' },
      { ok: false, code: 'FORBIDDEN', message: '無法存取這個檔案。' },
      { ok: false, code: 'FILE_GONE', message: '這張頭像已經換掉了。' },
      { ok: false, code: 'INTERNAL', message: '檔案本體不見了，請聯絡系辦。' },
    ]
    for (const failure of failures) {
      downloadFile.mockResolvedValue(failure)
      for (const headers of [{}, { 'sec-fetch-dest': 'iframe' }, { 'sec-fetch-dest': 'document' }] as Record<string, string>[]) {
        const [p, d] = [await preview(headers), await download(headers)]
        const label = `${failure.code} ${JSON.stringify(headers)}`
        expect(p.status, label).toBe(d.status)
        expect(p.headers.get('cache-control'), label).toBe(d.headers.get('cache-control'))
        expect(p.headers.get('content-disposition'), label).toBeNull()
        expect(await p.text(), label).toBe(await d.text())
        if (failure.code === 'UNAUTHENTICATED' && headers['sec-fetch-dest'] === 'document') {
          expect(p.headers.get('location')).toBe(`/login?next=${encodeURIComponent(`/api/files/${ID}/preview`)}`)
        } else {
          expect(p.headers.get('location'), label).toBe(d.headers.get('location'))
        }
      }
    }
    // iframe 裡的拒絕不導頁（維持 JSON 401／403）。
    downloadFile.mockResolvedValue(failures[1])
    expect((await preview({ 'sec-fetch-dest': 'iframe' })).status).toBe(403)
  })

  it('快取同下載路由：公開 PNG 給公開快取＋ETag，帶相符 ETag 回 304（仍帶預覽標頭、串流已取消）', async () => {
    downloadFile.mockResolvedValue({ ok: true, receipt: receipt({ mime: 'image/png', publicRead: true }) })
    const ok = await preview()
    expect(ok.headers.get('cache-control')).toMatch(/^public, max-age=\d+, must-revalidate$/)
    expect(ok.headers.get('etag')).toBe(`"${CHECKSUM}"`)

    const r = receipt({ mime: 'image/png', publicRead: true })
    const cancel = vi.spyOn(r.body, 'cancel')
    downloadFile.mockResolvedValue({ ok: true, receipt: r })
    const notModified = await preview({ 'if-none-match': `"${CHECKSUM}"` })
    expect(notModified.status).toBe(304)
    expect(notModified.headers.get('x-frame-options')).toBe('SAMEORIGIN')
    expect(notModified.headers.get('content-security-policy')).toContain("frame-ancestors 'self'")
    expect(cancel).toHaveBeenCalled()
  })

  it('頭像：不帶原始檔名；HEAD 只有標頭、串流已取消', async () => {
    const r = receipt({ purpose: 'avatar', mime: 'image/webp', originalName: '身分證.jpg' })
    const cancel = vi.spyOn(r.body, 'cancel')
    downloadFile.mockResolvedValue({ ok: true, receipt: r })
    const response = await preview({}, 'HEAD')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toContain('filename="avatar.webp"')
    expect(response.headers.get('cache-control')).toBe('private, no-cache')
    expect(cancel).toHaveBeenCalled()
    expect(response.body).toBeNull()
  })
})
