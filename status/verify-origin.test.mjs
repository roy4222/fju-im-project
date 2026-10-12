// AC-S-25(c) 的 origin 部分：/probe 累加、/count 唯讀、其他路徑 404 不加。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createVerifyOrigin } from './verify-origin.mjs'

let server
let base

beforeEach(async () => {
  server = createVerifyOrigin()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

afterEach(() => new Promise((resolve) => server.close(resolve)))

const count = async () => {
  const res = await fetch(`${base}/count`)
  expect(res.status).toBe(200)
  return Number((await res.text()).trim())
}

describe('verify-origin', () => {
  it('一開始是 0，讀 /count 不會加', async () => {
    expect(await count()).toBe(0)
    expect(await count()).toBe(0)
  })

  it('/probe 三次後 /count 連讀兩次都是 3', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${base}/probe`)
      expect(res.status).toBe(204)
    }
    expect(await count()).toBe(3)
    expect(await count()).toBe(3)
  })

  it('GET /x 回 404 且不加；POST /probe、帶查詢字串以外的變體也不加', async () => {
    expect((await fetch(`${base}/x`)).status).toBe(404)
    expect((await fetch(`${base}/probe`, { method: 'POST' })).status).toBe(404)
    expect((await fetch(`${base}/probe/extra`)).status).toBe(404)
    expect((await fetch(`${base}/count`, { method: 'DELETE' })).status).toBe(404)
    expect(await count()).toBe(0)
  })

  it('直接以 node 執行時會在 VERIFY_ORIGIN_PORT 起來', async () => {
    const { spawn } = await import('node:child_process')
    const { fileURLToPath } = await import('node:url')
    const port = 18000 + Math.floor(Math.random() * 1000)
    const child = spawn(process.execPath, [fileURLToPath(new URL('./verify-origin.mjs', import.meta.url))], {
      env: { ...process.env, VERIFY_ORIGIN_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    try {
      await new Promise((resolve, reject) => {
        child.stdout.once('data', resolve)
        child.once('exit', (code) => reject(new Error(`提早結束 ${code}`)))
      })
      expect((await fetch(`http://127.0.0.1:${port}/probe`)).status).toBe(204)
      expect((await (await fetch(`http://127.0.0.1:${port}/count`)).text()).trim()).toBe('1')
    } finally {
      child.kill('SIGTERM')
    }
  })
})
