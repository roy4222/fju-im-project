import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileDownload } from '@/application/ops'

// 路由只管 HTTP：授權結果換成狀態碼與快取標頭。授權本身（含「換掉的頭像 → FILE_GONE」）在 file-storage 的整合測試。
const downloadFile = vi.fn()
vi.mock('@/composition/files', async () => {
  const ops = await import('@/application/ops')
  return {
    downloadFile: (...args: unknown[]) => downloadFile(...args),
    contentDisposition: ops.contentDispositionFor,
    isCacheableDownload: ops.isCacheableDownload,
    PUBLIC_IMAGE_MAX_AGE_SECONDS: ops.PUBLIC_IMAGE_MAX_AGE_SECONDS,
  }
})

const { GET } = await import('./route')

const ID = '01890000-0000-7000-8000-000000000001'
const CHECKSUM = 'a'.repeat(64)

function receipt(overrides: Partial<FileDownload> = {}): FileDownload {
  return {
    fileId: ID,
    purpose: 'avatar',
    originalName: 'me.jpg',
    sizeBytes: 3,
    mime: 'image/webp',
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

function get(headers: Record<string, string> = {}) {
  return GET(new Request(`http://localhost/api/files/${ID}`, { headers }), { params: Promise.resolve({ id: ID }) })
}

describe('GET /api/files/[id]：頭像（SH-9）', () => {
  beforeEach(() => downloadFile.mockReset())

  it('頭像 200：private, no-cache＋ETag（每次使用前回來重新授權）', async () => {
    downloadFile.mockResolvedValue({ ok: true, receipt: receipt() })
    const response = await get()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-cache')
    expect(response.headers.get('etag')).toBe(`"${CHECKSUM}"`)
    expect(response.headers.get('content-type')).toBe('image/webp')
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
  })

  it('帶相符的 If-None-Match → 304，標頭仍是 private, no-cache，串流已取消', async () => {
    const r = receipt()
    const cancel = vi.spyOn(r.body, 'cancel')
    downloadFile.mockResolvedValue({ ok: true, receipt: r })
    const response = await get({ 'if-none-match': `"${CHECKSUM}"` })
    expect(response.status).toBe(304)
    expect(response.headers.get('cache-control')).toBe('private, no-cache')
    expect(response.headers.get('etag')).toBe(`"${CHECKSUM}"`)
    expect(cancel).toHaveBeenCalled()
  })

  it('換掉的頭像（FILE_GONE）→ 404 JSON；瀏覽器直接開（sec-fetch-dest: document）也是 404，不導 /403', async () => {
    downloadFile.mockResolvedValue({ ok: false, code: 'FILE_GONE', message: '這張頭像已經換掉了。' })
    const variants: Record<string, string>[] = [{}, { 'sec-fetch-dest': 'document' }, { 'if-none-match': `"${CHECKSUM}"` }]
    for (const headers of variants) {
      const response = await get(headers)
      expect(response.status).toBe(404)
      expect(response.headers.get('location')).toBeNull()
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(await response.json()).toMatchObject({ ok: false, code: 'FILE_GONE' })
    }
  })

  it('其他用途不變：私有檔 no-store、沒有 ETag，帶 If-None-Match 也是 200；拒絕仍是 403／導 /403', async () => {
    downloadFile.mockResolvedValue({ ok: true, receipt: receipt({ purpose: 'submission', mime: 'application/pdf' }) })
    const response = await get({ 'if-none-match': `"${CHECKSUM}"` })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('etag')).toBeNull()

    downloadFile.mockResolvedValue({ ok: false, code: 'FORBIDDEN', message: '無法存取這個檔案。' })
    expect((await get()).status).toBe(403)
    const navigated = await get({ 'sec-fetch-dest': 'document' })
    expect(navigated.status).toBe(303)
    expect(navigated.headers.get('location')).toBe('/403')
  })
})
