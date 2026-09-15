import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const exec = promisify(execFile)
const repoRoot = path.join(import.meta.dirname, '..', '..', '..')
const caddyfile = path.join(repoRoot, 'Caddyfile')

/**
 * R6：上傳上限在 Caddy（契約 02 §6），而且要**真的擋得住**。
 *
 * 契約值是 105MB。直接丟 105MB 進 CI 太慢，所以 Caddyfile 把上限寫成
 * `{$UPLOAD_MAX_SIZE:105MB}`——預設就是契約值，測試另外起一組 Caddy 把它壓成 1KB，
 * 用**同一份設定檔**證明「超過就 413、沒超過就真的到得了 upstream」。
 *
 * 必須有真的 upstream：Caddy 的 `request_body max_size` 是在**讀** body 的時候才超限報 413，
 * 而 reverse_proxy 要連得上 upstream 才會開始讀。upstream 不存在的話一律先回 502，
 * 那樣的測試會假裝通過。
 */

const NETWORK = 'fju-upload-limit-test-net'
const PROXY = 'fju-upload-limit-test-proxy'
const UPSTREAM = 'fju-upload-limit-test-upstream'
const PORT = 18099
const LIMIT_BYTES = 1000 // UPLOAD_MAX_SIZE=1KB

const upstreamCaddyfile = path.join(os.tmpdir(), 'fju-upload-limit-upstream.Caddyfile')

async function docker(args: string[]) {
  return exec('docker', args, { cwd: repoRoot })
}

async function cleanup() {
  await docker(['rm', '-f', PROXY, UPSTREAM]).catch(() => undefined)
  await docker(['network', 'rm', NETWORK]).catch(() => undefined)
}

/** 送一個指定大小的 body，回 HTTP 狀態碼。 */
async function post(bytes: number): Promise<number> {
  const file = path.join(os.tmpdir(), `fju-upload-${bytes}.bin`)
  fs.writeFileSync(file, Buffer.alloc(bytes, 0x78))
  try {
    const { stdout } = await exec('curl', [
      '-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '20',
      '-X', 'POST',
      '-H', 'content-type: application/octet-stream',
      '--data-binary', `@${file}`,
      `http://127.0.0.1:${PORT}/api/files/upload`,
    ])
    return Number(stdout.trim())
  } finally {
    fs.rmSync(file, { force: true })
  }
}

describe('Caddyfile 的上限與契約一致', () => {
  const source = fs.readFileSync(caddyfile, 'utf8')

  it('預設值就是契約 02 §6 的 105MB', () => {
    expect(source).toMatch(/max_size \{\$UPLOAD_MAX_SIZE:105MB\}/)
  })

  it('上限設在 proxy，Server Action 的 bodySizeLimit 維持預設（沒有被設定）', () => {
    const nextConfig = fs.readFileSync(path.join(repoRoot, 'web/next.config.ts'), 'utf8')
    // 註解裡提到它沒關係，重點是沒有真的去設定。
    expect(nextConfig).not.toMatch(/bodySizeLimit\s*:/)
    expect(nextConfig).not.toMatch(/serverActions\s*:/)
  })
})

describe('同一份 Caddyfile 真的擋得住超量請求', () => {
  beforeAll(async () => {
    await cleanup()
    fs.writeFileSync(
      upstreamCaddyfile,
      ['{', '\tadmin off', '\tauto_https off', '}', ':3000 {', '\trespond "upstream ok" 200', '}', ''].join('\n'),
    )
    await docker(['network', 'create', NETWORK])
    // 別名 app，因為 Caddyfile 裡 reverse_proxy 的目標寫死是 app:3000。
    await docker([
      'run', '-d', '--name', UPSTREAM, '--network', NETWORK, '--network-alias', 'app',
      '-v', `${upstreamCaddyfile}:/etc/caddy/Caddyfile:ro`, 'caddy:2.10-alpine',
    ])
    await docker([
      'run', '-d', '--name', PROXY, '--network', NETWORK,
      '-p', `127.0.0.1:${PORT}:80`,
      '-e', 'UPLOAD_MAX_SIZE=1KB',
      '-v', `${caddyfile}:/etc/caddy/Caddyfile:ro`, 'caddy:2.10-alpine',
    ])

    for (let i = 0; i < 40; i += 1) {
      const code = await post(10).catch(() => 0)
      if (code === 200) return
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    throw new Error('Caddy 與 upstream 沒有在時間內起來')
  }, 180_000)

  afterAll(async () => {
    await cleanup()
    fs.rmSync(upstreamCaddyfile, { force: true })
  })

  it('沒超過上限的請求真的到得了 upstream', async () => {
    expect(await post(512)).toBe(200)
  })

  it('剛好在上限邊界內的請求放行', async () => {
    expect(await post(LIMIT_BYTES)).toBe(200)
  })

  it('超過上限的請求被 Caddy 擋下回 413，不會進到 app', async () => {
    expect(await post(LIMIT_BYTES + 1)).toBe(413)
    expect(await post(4096)).toBe(413)
  })
})
