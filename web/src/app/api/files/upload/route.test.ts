import { describe, expect, it, vi } from 'vitest'

// 路由只管 HTTP：上傳結果換成狀態碼。封存守門本身在 pg-items／pg-submissions 的整合測試。
const uploadFile = vi.fn()
vi.mock('@/composition/files', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/composition/files')>()),
  uploadFile: (...args: unknown[]) => uploadFile(...args),
}))

const { POST } = await import('./route')

function post() {
  return POST(
    new Request('http://localhost/api/files/upload?ticket=t', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', 'content-length': '3' },
      body: new Uint8Array([1, 2, 3]),
    }),
  )
}

describe('POST /api/files/upload', () => {
  it('拿憑證後屆別才封存（AC-55 F4）：409，錯誤碼與中文訊息原樣帶回，不算伺服器錯誤', async () => {
    uploadFile.mockResolvedValueOnce({ ok: false, code: 'COHORT_ARCHIVED', message: '這一屆已經封存，不能再上傳檔案。' })
    const res = await post()
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ ok: false, code: 'COHORT_ARCHIVED', message: '這一屆已經封存，不能再上傳檔案。' })
  })
})
