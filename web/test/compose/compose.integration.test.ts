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

async function composeConfig(files: string[] = ['docker-compose.yml']): Promise<Record<string, unknown>> {
  const args = files.flatMap((file) => ['-f', file])
  const { stdout } = await exec('docker', ['compose', ...args, 'config', '--format', 'json'], { cwd: repoRoot })
  return JSON.parse(stdout) as Record<string, unknown>
}

type PortMapping = { host_ip?: string; published?: string | number; target?: number }
type ConfiguredServices = Record<string, { ports?: PortMapping[] } | undefined>

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

describe('對宿主機發布的 port（R3）', () => {
  it('基礎 compose 只有 caddy 對外，postgres 完全不發布', async () => {
    const services = (await composeConfig()).services as ConfiguredServices
    const published = Object.entries(services)
      .filter(([, svc]) => (svc?.ports ?? []).length > 0)
      .map(([name]) => name)
    // SOP 01 §4 的 ufw 只開 22/80/443；VM 上多發布一個 5432 等於在防火牆之外
    // 開一個帶已知 superuser 憑證的入口。
    expect(published).toEqual(['caddy'])
    expect(services.postgres?.ports ?? []).toEqual([])
  })

  it('本機覆蓋把 postgres 發布出來，但只綁 127.0.0.1', async () => {
    const services = (await composeConfig(['docker-compose.yml', 'docker-compose.local.yml']))
      .services as ConfiguredServices
    const ports = services.postgres?.ports ?? []
    expect(ports).toHaveLength(1)
    expect(ports[0]?.host_ip).toBe('127.0.0.1')
    expect(Number(ports[0]?.target)).toBe(5432)
  })

  it('本機覆蓋沒有任何服務綁到 0.0.0.0 的資料庫埠', async () => {
    const services = (await composeConfig(['docker-compose.yml', 'docker-compose.local.yml']))
      .services as ConfiguredServices
    for (const [name, svc] of Object.entries(services)) {
      for (const port of svc?.ports ?? []) {
        if (Number(port.target) === 5432) {
          expect(port.host_ip, `${name} 的 5432 綁到 ${port.host_ip}`).toBe('127.0.0.1')
        }
      }
    }
  })

  it('本機覆蓋預設只起 postgres，其餘五個要 --profile full', async () => {
    const raw = YAML.parse(fs.readFileSync(path.join(repoRoot, 'docker-compose.local.yml'), 'utf8')) as {
      services: Record<string, { profiles?: string[] } | undefined>
    }
    for (const name of ['migrate', 'app', 'worker', 'caddy', 'backup']) {
      expect(raw.services[name]?.profiles, `${name} 少了 full profile`).toEqual(['full'])
    }
    expect(raw.services.postgres?.profiles).toBeUndefined()
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
      'FILES_ROOT',
      'FILE_MAX_BYTES',
      'BUSINESS_CLOCK_OVERRIDE_ENABLED',
      'DATABASE_URL_OWNER',
      'DATABASE_URL_BACKUP',
    ]) {
      expect(names, `少了 ${name}`).toContain(name)
    }
  })

  it('不用的服務（Turnstile、R2、age、告警 webhook）不再列（Roy 2026-09-23 定案）', () => {
    const names = lines.map((l) => l.slice(0, -1))
    for (const prefix of ['TURNSTILE_', 'R2_', 'AGE_', 'ALERT_WEBHOOK']) {
      expect(names.filter((n) => n.startsWith(prefix)), `${prefix}* 應該拿掉`).toEqual([])
    }
  })
})

/** VM 上 doppler run 放進環境的鍵（全是假值）。 */
const FAKE_SITE_SECRETS: Record<string, string> = {
  POSTGRES_USER: 'fake_owner',
  POSTGRES_PASSWORD: 'fake',
  POSTGRES_DB: 'fju',
  DATABASE_URL: 'postgres://fju_app:fake@postgres:5432/fju',
  DATABASE_URL_OWNER: 'postgres://fake_owner:fake@postgres:5432/fju',
  BETTER_AUTH_SECRET: 'fake',
  BETTER_AUTH_URL: 'https://test.fju.roy422.dev',
  GOOGLE_CLIENT_ID: 'fake',
  GOOGLE_CLIENT_SECRET: 'fake',
  FILES_ROOT: '/srv/fju/files',
  FILE_MAX_BYTES: '104857600',
  BUSINESS_CLOCK_OVERRIDE_ENABLED: 'true',
}

type SiteService = {
  container_name?: string
  env_file?: unknown
  environment?: Record<string, string>
  ports?: PortMapping[]
  networks?: Record<string, unknown>
  volumes?: { source: string; target: string }[]
}

/** 跟 ops/lib/site.sh 一樣的方式解析某一站（COMPOSE_FILE＋COMPOSE_PROJECT_NAME＋FJU_SITE）。 */
async function siteConfig(site: 'test' | 'prod', secrets: Record<string, string> = FAKE_SITE_SECRETS) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...secrets,
    FJU_SITE: site,
    COMPOSE_PROJECT_NAME: `fju-${site}`,
    COMPOSE_FILE: `${path.join(repoRoot, 'docker-compose.yml')}:${path.join(repoRoot, 'docker-compose.vm.yml')}`,
  }
  const { stdout } = await exec('docker', ['compose', 'config', '--format', 'json'], { cwd: repoRoot, env })
  return JSON.parse(stdout) as {
    name: string
    services: Record<string, SiteService>
    volumes: Record<string, { name: string }>
    networks: Record<string, { name?: string; external?: boolean }>
  }
}

describe('VM 兩站（docker-compose.vm.yml，2026-09-24）', () => {
  it('兩站是不同的 project，資料庫 volume 各自一顆（不會共用 fju-im-project-pgdata）', async () => {
    const [test, prod] = await Promise.all([siteConfig('test'), siteConfig('prod')])
    expect(test.name).toBe('fju-test')
    expect(prod.name).toBe('fju-prod')
    expect(test.volumes['fju-pgdata']?.name).toBe('fju-test-pgdata')
    expect(prod.volumes['fju-pgdata']?.name).toBe('fju-prod-pgdata')
    const testNames = Object.values(test.services).map((s) => s.container_name)
    const prodNames = Object.values(prod.services).map((s) => s.container_name)
    expect(testNames.filter((n) => prodNames.includes(n))).toEqual([])
  })

  it('站台只起 postgres、migrate、app、worker；caddy 與 backup 不在站台 project 裡跑', async () => {
    const test = await siteConfig('test')
    expect(Object.keys(test.services).sort()).toEqual(['app', 'migrate', 'postgres', 'worker'])
  })

  it('站台 project 對宿主機不發布任何 port（對外只有共用的 Caddy）', async () => {
    const test = await siteConfig('test')
    for (const [name, svc] of Object.entries(test.services)) {
      expect(svc.ports ?? [], `${name} 不該發布 port`).toEqual([])
    }
  })

  it('不讀任何 .env 檔；秘密逐項給，app 看不到 owner 連線、migrate 看不到 app 組', async () => {
    const test = await siteConfig('test')
    for (const name of ['migrate', 'app', 'worker']) {
      expect(test.services[name]?.env_file ?? [], `${name} 還有 env_file`).toEqual([])
    }
    expect(Object.keys(test.services.migrate?.environment ?? {})).toEqual(['DATABASE_URL_OWNER'])
    for (const name of ['app', 'worker']) {
      const keys = Object.keys(test.services[name]?.environment ?? {})
      expect(keys).toContain('DATABASE_URL')
      expect(keys).toContain('BETTER_AUTH_SECRET')
      expect(keys).not.toContain('DATABASE_URL_OWNER')
      expect(keys).not.toContain('POSTGRES_PASSWORD')
    }
  })

  it('少一個秘密就整個失敗，不會用空值把容器建起來', async () => {
    const partial = { ...FAKE_SITE_SECRETS }
    delete partial.DATABASE_URL
    await expect(siteConfig('test', partial)).rejects.toThrow(/Doppler 少了 DATABASE_URL/)
  })

  it('app 加入外部網路 fju-edge，名字是 fju-<站台>-app（Caddyfile.vm 靠它找到）', async () => {
    const [test, prod] = await Promise.all([siteConfig('test'), siteConfig('prod')])
    expect(test.services.app?.container_name).toBe('fju-test-app')
    expect(prod.services.app?.container_name).toBe('fju-prod-app')
    expect(Object.keys(test.services.app?.networks ?? {})).toContain('edge')
    expect(test.networks.edge).toMatchObject({ name: 'fju-edge', external: true })
    // postgres 只在站台自己的網路，另一站與 Caddy 都連不到。
    expect(Object.keys(test.services.postgres?.networks ?? {})).toEqual(['default'])
  })

  it('附件目錄是該站自己的 /srv/fju/<站台>/files', async () => {
    const test = await siteConfig('test')
    const mount = test.services.app?.volumes?.find((v) => v.target === FAKE_SITE_SECRETS.FILES_ROOT)
    expect(mount?.source).toBe('/srv/fju/test/files')
  })
})

describe('共用 Caddy（docker-compose.edge.yml）', () => {
  it('只有 caddy，只發布 80／443 的 TCP（跟 ufw 一致，不開 443/udp）', async () => {
    const config = await composeConfig(['docker-compose.edge.yml'])
    expect(config.name).toBe('fju-edge')
    const services = config.services as Record<string, SiteService>
    expect(Object.keys(services)).toEqual(['caddy'])
    const ports = (services.caddy?.ports ?? []).map((p) => `${p.published}:${p.target}/${(p as { protocol?: string }).protocol}`)
    expect(ports.sort()).toEqual(['443:443/tcp', '80:80/tcp'])
  })

  it('掛 ops/Caddyfile.vm：兩個網址分到兩站，b1／b2 插槽已拿掉', async () => {
    const config = await composeConfig(['docker-compose.edge.yml'])
    const caddy = (config.services as Record<string, SiteService>).caddy
    const mounted = caddy?.volumes?.find((v) => v.target === '/etc/caddy/Caddyfile')
    expect(mounted?.source).toBe(path.join(repoRoot, 'ops/Caddyfile.vm'))

    const caddyfile = fs.readFileSync(path.join(repoRoot, 'ops/Caddyfile.vm'), 'utf8')
    expect(caddyfile).toMatch(/^fju\.roy422\.dev \{[\s\S]*?reverse_proxy fju-prod-app:3000/m)
    expect(caddyfile).toMatch(/^test\.fju\.roy422\.dev \{[\s\S]*?reverse_proxy fju-test-app:3000/m)
    expect(caddyfile).not.toMatch(/b[12]\.fju/)
    expect(caddyfile).toMatch(/max_size \{\$UPLOAD_MAX_SIZE:105MB\}/)
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
