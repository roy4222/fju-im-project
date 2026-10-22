import { describe, expect, it, vi } from 'vitest'
import { pingHealthchecks } from '@/infrastructure/notifications/healthchecks-ping'

/** ⑤-06：worker 每 5 分鐘對 Healthchecks.io 打一次卡（AC-40、AC-41）。網址都是假的。 */

const FAKE_URL = 'https://hc.example/ping/fake'

function deps(fetchImpl: typeof fetch) {
  const log = vi.fn<(message: string, detail?: Record<string, unknown>) => void>()
  return { fetch: fetchImpl, log }
}

describe('pingHealthchecks', () => {
  it('有網址：打一次，回 sent，不記 log', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('OK', { status: 200 }))
    const d = deps(fetchImpl)
    await expect(pingHealthchecks({ url: FAKE_URL, ...d })).resolves.toBe('sent')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(FAKE_URL)
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(d.log).not.toHaveBeenCalled()
  })

  it.each([undefined, '', '   '])('沒設網址（%j）：不打、不記 log', async (url) => {
    const fetchImpl = vi.fn<typeof fetch>()
    const d = deps(fetchImpl)
    await expect(pingHealthchecks({ url, ...d })).resolves.toBe('skipped')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(d.log).not.toHaveBeenCalled()
  })

  it('回非 2xx：只記一行 log（帶狀態碼、不帶網址），不丟錯', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('nope', { status: 503 }))
    const d = deps(fetchImpl)
    await expect(pingHealthchecks({ url: FAKE_URL, ...d })).resolves.toBe('failed')
    expect(d.log).toHaveBeenCalledTimes(1)
    expect(d.log.mock.calls[0]?.[1]).toEqual({ status: 503 })
    expect(JSON.stringify(d.log.mock.calls)).not.toContain('hc.example')
  })

  it('連線失敗或逾時：只記一行 log，不丟錯、不帶網址', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError(`fetch failed`)
    })
    const d = deps(fetchImpl)
    await expect(pingHealthchecks({ url: FAKE_URL, ...d })).resolves.toBe('failed')
    expect(d.log).toHaveBeenCalledTimes(1)
    expect(d.log.mock.calls[0]?.[1]).toEqual({ error: 'TypeError: fetch failed' })
    expect(JSON.stringify(d.log.mock.calls)).not.toContain('hc.example')
  })

  it('錯誤訊息剛好含網址時，log 裡換成「（網址）」', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error(`connect ECONNREFUSED ${FAKE_URL}`)
    })
    const d = deps(fetchImpl)
    await pingHealthchecks({ url: FAKE_URL, ...d })
    expect(JSON.stringify(d.log.mock.calls)).not.toContain('hc.example')
    expect(d.log.mock.calls[0]?.[1]).toEqual({ error: 'Error: connect ECONNREFUSED （網址）' })
  })
})
