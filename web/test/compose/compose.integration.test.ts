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
      // B 階段 VB-1：寄信、Turnstile、GA4，以及只限本機與 CI 的擷取模式。
      'BREVO_API_KEY',
      'MAIL_FROM',
      'MAIL_CAPTURE',
      'TURNSTILE_SITE_KEY',
      'TURNSTILE_SECRET_KEY',
      'GA4_MEASUREMENT_ID',
    ]) {
      expect(names, `少了 ${name}`).toContain(name)
    }
  })

  describe('「空字串」和「沒設」行為不同的鍵不准列（CL-7 #823 第 11 條）', () => {
    // 照 .env.example 複製成 .env 會把每個鍵都設成空字串；程式若把「沒設」跟「空字串」分開處理，
    // 留空就等於悄悄選了另一種行為（RV-C #828：IMAGE_DIGEST 留空時 /api/health 回 "" 而不是 null）。
    const names = new Set(lines.map((l) => l.slice(0, -1)))

    /** 自動掃描抓不到、但確定「空字串≠沒設」的鍵：不准出現在 .env.example。 */
    const KNOWN_EMPTY_DIFFERS: Record<string, string> = {
      REGISTRATION_OPEN:
        '沒有這個鍵才算開放註冊，空字串當關閉（registration-switch.ts）；VM 由 docker-compose.vm.yml 的 ${REGISTRATION_OPEN:-false} 給值',
    }

    /** 掃得到 `?? `／`=== undefined`，但空字串跟沒設結果一樣（或是必填鍵），可以留在 .env.example。 */
    const ALLOWED: Record<string, string> = {
      BETTER_AUTH_URL: "必填（ops/lib/site.sh 的 FJU_REQUIRED_SECRETS 擋空值）；程式裡一律寫 `?? ''`，空字串與沒設結果相同",
      GOOGLE_CLIENT_ID: "必填（FJU_REQUIRED_SECRETS）；auth-instance.ts 寫 `?? ''`，空字串與沒設結果相同",
      GOOGLE_CLIENT_SECRET: "必填（FJU_REQUIRED_SECRETS）；auth-instance.ts 寫 `?? ''`，空字串與沒設結果相同",
      DATABASE_URL: '必填（FJU_REQUIRED_SECRETS）；只有 scripts/auth-generate.mjs 產生 schema 時給佔位值，不連線',
      BETTER_AUTH_SECRET: '必填（FJU_REQUIRED_SECRETS）；只有 scripts/auth-generate.mjs 產生 schema 時給佔位值，不連線',
      HEALTHCHECKS_WORKER_URL: "composition/worker.ts 寫 `?? ''` 再 trim，空字串與沒設一樣＝不打卡（compose 測試 AC-40a 也斷言沒設時是空字串）",
      GIT_COMMIT:
        'worker-main.ts 寫 `?? unknown`；容器裡的值來自 Dockerfile 的 ARG，Compose 用 ${GIT_COMMIT:-unknown} 傳，空字串在 Compose 就換成 unknown（health-reader.ts 也把空字串當沒設）',
    }

    /** 找出把「沒設」單獨處理的寫法：`process.env.X ??`、`process.env.X === undefined`、`'X' in process.env`，以及先存進變數再比 undefined。 */
    function scanEmptyDiffers(src: string): string[] {
      const found = new Set<string>()
      const direct =
        /process\.env(?:\.([A-Z][A-Z0-9_]*)|\[['"]([A-Z][A-Z0-9_]*)['"]\])\s*(?:\?\?|[!=]==?\s*undefined)|['"]([A-Z][A-Z0-9_]*)['"]\s+in\s+process\.env/g
      for (const m of src.matchAll(direct)) found.add(m[1] ?? m[2] ?? m[3])
      for (const m of src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*process\.env\.([A-Z][A-Z0-9_]*)\s*(?:\n|;)/g)) {
        if (new RegExp(`\\b${m[1]}\\s*(?:\\?\\?|[!=]==?\\s*undefined)`).test(src)) found.add(m[2])
      }
      return [...found]
    }

    function sourceFiles(dir: string): string[] {
      return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
        const p = path.join(dir, d.name)
        if (d.isDirectory()) return d.name === 'node_modules' ? [] : sourceFiles(p)
        return /\.(ts|tsx|mjs)$/.test(d.name) && !/\.test\.(ts|tsx|mjs)$/.test(d.name) ? [p] : []
      })
    }

    const hits = new Map<string, string[]>()
    for (const file of ['src', 'scripts'].flatMap((d) => sourceFiles(path.join(repoRoot, 'web', d)))) {
      for (const name of scanEmptyDiffers(fs.readFileSync(file, 'utf8'))) {
        hits.set(name, [...(hits.get(name) ?? []), path.relative(repoRoot, file)])
      }
    }

    it('已知名單裡的鍵不在 .env.example', () => {
      for (const [name, why] of Object.entries(KNOWN_EMPTY_DIFFERS)) {
        expect(names.has(name), `${name} 不該列在 .env.example：${why}`).toBe(false)
      }
    })

    it('掃到的鍵若在 .env.example，必須在白名單附理由；白名單沒有過時的列', () => {
      const offending = [...hits]
        .filter(([name]) => names.has(name) && !(name in ALLOWED))
        .map(([name, files]) => `${name}（${files.join('、')}）`)
      expect(offending, '這些鍵空字串和沒設行為不同：從 .env.example 拿掉、改程式把空字串當沒設，或列進白名單附理由').toEqual([])
      const stale = Object.keys(ALLOWED).filter((name) => !hits.has(name) || !names.has(name))
      expect(stale, '白名單裡這些鍵已經掃不到（或不在 .env.example），請拿掉').toEqual([])
    })

    it('掃描本身抓得到：REGISTRATION_OPEN（先存變數再比 undefined）、反例 `process.env.IMAGE_DIGEST ?? null` 會被擋', () => {
      expect(hits.has('REGISTRATION_OPEN')).toBe(true)
      expect(scanEmptyDiffers("imageDigest: process.env.IMAGE_DIGEST ?? null,")).toEqual(['IMAGE_DIGEST'])
      expect(scanEmptyDiffers("if (process.env['APP_VERSION'] === undefined) {}")).toEqual(['APP_VERSION'])
      expect(scanEmptyDiffers("const on = 'MAIL_CAPTURE' in process.env")).toEqual(['MAIL_CAPTURE'])
      expect(names.has('IMAGE_DIGEST') && !('IMAGE_DIGEST' in ALLOWED)).toBe(true)
    })
  })

  it('不用的服務（R2、age、告警 webhook）不再列（Roy 2026-09-23 定案；Turnstile 在 B 階段改成要用）', () => {
    const names = lines.map((l) => l.slice(0, -1))
    for (const prefix of ['R2_', 'AGE_', 'ALERT_WEBHOOK']) {
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

  it('寄信、Turnstile、GA4 的鍵 app 與 worker 都拿得到；擷取模式與不用的服務一個都不給（B 階段 VB-1）', async () => {
    const test = await siteConfig('test', {
      ...FAKE_SITE_SECRETS,
      BREVO_API_KEY: 'fake',
      MAIL_FROM: '專題管理平台 <noreply@roy422.dev>',
      // 就算 VM 的環境裡誤設了，compose 也不轉交。
      MAIL_CAPTURE: '1',
    })
    for (const name of ['app', 'worker']) {
      const env = test.services[name]?.environment ?? {}
      const keys = Object.keys(env)
      for (const key of ['BREVO_API_KEY', 'MAIL_FROM', 'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'GA4_MEASUREMENT_ID']) {
        expect(keys, `${name} 少了 ${key}`).toContain(key)
      }
      expect(env.MAIL_FROM).toBe('專題管理平台 <noreply@roy422.dev>')
      expect(keys).not.toContain('MAIL_CAPTURE')
      for (const prefix of ['R2_', 'AGE_', 'ALERT_WEBHOOK']) {
        expect(keys.filter((k) => k.startsWith(prefix)), `${name} 不該有 ${prefix}*`).toEqual([])
      }
    }
  })

  it('寄信、Turnstile、GA4 的鍵 Doppler 沒設也起得來（留空，不像必要鍵一樣整個失敗）', async () => {
    const test = await siteConfig('test')
    expect(test.services.app?.environment?.BREVO_API_KEY).toBe('')
    expect(test.services.app?.environment?.TURNSTILE_SECRET_KEY).toBe('')
  })

  it('worker 的連線池上限固定 2，app 不設（用程式預設 10，SH-B2）', async () => {
    const test = await siteConfig('test')
    expect(test.services.worker?.environment?.DB_POOL_MAX).toBe('2')
    expect(Object.keys(test.services.app?.environment ?? {})).not.toContain('DB_POOL_MAX')
  })

  it('Healthchecks.io 打卡網址只轉交給 worker，app 拿不到；沒設時 worker 是空字串（⑤-06，AC-40a）', async () => {
    const fake = 'https://hc.example/ping/fake'
    const given = await siteConfig('test', { ...FAKE_SITE_SECRETS, HEALTHCHECKS_WORKER_URL: fake })
    expect(given.services.worker?.environment?.HEALTHCHECKS_WORKER_URL).toBe(fake)
    expect(Object.keys(given.services.app?.environment ?? {})).not.toContain('HEALTHCHECKS_WORKER_URL')

    const missing = await siteConfig('test')
    expect(missing.services.worker?.environment?.HEALTHCHECKS_WORKER_URL).toBe('')
    expect(Object.keys(missing.services.app?.environment ?? {})).not.toContain('HEALTHCHECKS_WORKER_URL')
  })

  it('少一個秘密就整個失敗，不會用空值把容器建起來', async () => {
    const partial = { ...FAKE_SITE_SECRETS }
    delete partial.DATABASE_URL
    await expect(siteConfig('test', partial)).rejects.toThrow(/Doppler 少了 DATABASE_URL/)
  })

  it('app 只加入自己站台的外部網路 fju-edge-<站台>，名字是 fju-<站台>-app（Caddyfile.vm 靠它找到）', async () => {
    const [test, prod] = await Promise.all([siteConfig('test'), siteConfig('prod')])
    expect(test.services.app?.container_name).toBe('fju-test-app')
    expect(prod.services.app?.container_name).toBe('fju-prod-app')
    // 兩站各走各的網路（T4）：測試站的容器連不到正式站的 app。
    // 鍵名是 site-edge（不是拆分前的 edge），重部署同一個映像時 Compose 才會重建容器換網路。
    expect(Object.keys(test.services.app?.networks ?? {}).sort()).toEqual(['default', 'site-edge'])
    expect(Object.keys(prod.services.app?.networks ?? {}).sort()).toEqual(['default', 'site-edge'])
    expect(test.networks['site-edge']).toMatchObject({ name: 'fju-edge-test', external: true })
    expect(prod.networks['site-edge']).toMatchObject({ name: 'fju-edge-prod', external: true })
    expect(test.networks.edge).toBeUndefined()
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

  it('caddy 同時接 fju-edge-test 與 fju-edge-prod，不接拆分前的 fju-edge', async () => {
    const config = await composeConfig(['docker-compose.edge.yml'])
    const caddy = (config.services as Record<string, SiteService>).caddy
    const networks = config.networks as Record<string, { name?: string; external?: boolean }>
    const attached = Object.keys(caddy?.networks ?? {}).map((key) => networks[key])
    expect(attached.map((n) => n?.name).sort()).toEqual(['fju-edge-prod', 'fju-edge-test'])
    for (const network of attached) expect(network?.external).toBe(true)
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
