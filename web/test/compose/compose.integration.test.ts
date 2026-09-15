import { afterAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'

const exec = promisify(execFile)
const repoRoot = path.join(import.meta.dirname, '..', '..', '..')

/**
 * S00-07：Compose 定義與 `.env.example`。
 *
 * 兩件事要證明：六個服務都在、憑證分三組；以及「migrate 沒跑成功，app 就不會起來」
 * 不只是寫在 yml 上，而是 Compose 真的會這樣做——所以最後一個案例是實際跑一次注入失敗。
 */

async function composeConfig(): Promise<Record<string, unknown>> {
  const { stdout } = await exec('docker', ['compose', 'config', '--format', 'json'], { cwd: repoRoot })
  return JSON.parse(stdout) as Record<string, unknown>
}

describe('docker compose config', () => {
  it('六個服務齊全，名稱固定', async () => {
    const config = await composeConfig()
    const services = Object.keys(config.services as Record<string, unknown>).sort()
    expect(services).toEqual(['app', 'backup', 'caddy', 'migrate', 'postgres', 'worker'])
  })

  it('migrate 用 owner 憑證，app 與 worker 用 app 憑證，backup 用 backup 憑證', () => {
    // `docker compose config` 會把 env_file 展開成 environment，所以這裡讀原始 yml：
    // 要證明的是「定義上三組憑證分檔」，不是展開後的值。
    const raw = YAML.parse(fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8')) as {
      services: Record<string, { env_file?: string[] } | undefined>
    }
    const envFile = (name: string): string[] => raw.services[name]?.env_file ?? []

    expect(envFile('migrate')).toEqual(['.env.migrate'])
    expect(envFile('app')).toEqual(['.env'])
    expect(envFile('worker')).toEqual(['.env'])
    expect(envFile('backup')).toEqual(['.env.backup'])
    // 反過來也要成立：app 與 worker 看不到 owner 或 backup 的憑證檔。
    for (const name of ['app', 'worker']) {
      expect(envFile(name)).not.toContain('.env.migrate')
      expect(envFile(name)).not.toContain('.env.backup')
    }
  })

  it('app 與 worker 都等 migrate 成功結束才起來', async () => {
    const config = await composeConfig()
    const services = config.services as Record<
      string,
      { depends_on?: Record<string, { condition: string }> }
    >
    for (const name of ['app', 'worker']) {
      expect(services[name]?.depends_on?.migrate?.condition).toBe('service_completed_successfully')
      expect(services[name]?.depends_on?.postgres?.condition).toBe('service_healthy')
    }
  })

  it('caddy 掛的是 repo 的 Caddyfile，而且設了上傳上限', async () => {
    const config = await composeConfig()
    const services = config.services as Record<string, { volumes?: { source: string; target: string }[] }>
    const mounted = services.caddy?.volumes?.some((v) => v.target === '/etc/caddy/Caddyfile')
    expect(mounted).toBe(true)

    const caddyfile = fs.readFileSync(path.join(repoRoot, 'Caddyfile'), 'utf8')
    // 契約 02 §6 的值；實際擋不擋得住由 test/proxy 的整合測試證明。
    expect(caddyfile).toMatch(/max_size \{\$UPLOAD_MAX_SIZE:105MB\}/)
  })
})

describe('.env.example', () => {
  const lines = fs
    .readFileSync(path.join(repoRoot, '.env.example'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))

  it('每一行都是「變數名=」，一個值都沒有', () => {
    for (const line of lines) {
      expect(line, `這一行帶了值：${line}`).toMatch(/^[A-Z][A-Z0-9_]*=$/)
    }
  })

  it('契約 05 §6 三組憑證的變數名都在', () => {
    const names = new Set(lines.map((l) => l.slice(0, -1)))
    for (const name of [
      'DATABASE_URL',
      'BETTER_AUTH_SECRET',
      'BETTER_AUTH_URL',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'TURNSTILE_SITE_KEY',
      'TURNSTILE_SECRET_KEY',
      'FILES_ROOT',
      'FILE_MAX_BYTES',
      'BUSINESS_CLOCK_OVERRIDE_ENABLED',
      'DATABASE_URL_OWNER',
      'DATABASE_URL_BACKUP',
      'R2_ACCOUNT_ID',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'R2_BUCKET',
      'AGE_RECIPIENTS',
      'ALERT_WEBHOOK_URL',
    ]) {
      expect(names, `少了 ${name}`).toContain(name)
    }
  })
})

describe('注入：migrate 失敗時 app 不啟動', () => {
  const file = path.join(import.meta.dirname, 'migrate-failure.yml')
  const compose = (args: string[]) => exec('docker', ['compose', '-f', file, ...args], { cwd: repoRoot })

  afterAll(async () => {
    await compose(['down', '-v', '--remove-orphans']).catch(() => undefined)
  })

  it('migrate 非 0 結束，app 不會被啟動', async () => {
    await compose(['down', '-v', '--remove-orphans']).catch(() => undefined)

    let failed = false
    try {
      await compose(['up', '-d', 'app'])
    } catch {
      failed = true
    }
    expect(failed, 'migrate 失敗時 `compose up app` 應該失敗').toBe(true)

    const { stdout } = await compose(['ps', '--all', '--format', 'json'])
    const containers = stdout
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { Service: string; State: string; ExitCode?: number })

    const migrate = containers.find((c) => c.Service === 'migrate')
    expect(migrate?.State).toBe('exited')
    expect(migrate?.ExitCode).toBe(1)

    // Compose 會先把 app 的容器建出來，但因為 migrate 失敗而不會啟動它。
    const app = containers.find((c) => c.Service === 'app')
    expect(app?.State ?? 'absent').not.toBe('running')
  }, 120_000)
})
