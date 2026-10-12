// docker-compose.status.yml 與 ops/status-up.sh 的檢查（設計方案 §3.6、§3.7、§3.13；AC-S-6、AC-S-24 a）。
//
// compose 用 `docker compose config --format json` 解析（不需要 Docker daemon，CI 的 ubuntu runner 有）。
// 本機沒有 docker 時可設 DOCKER_COMPOSE_BIN 指到獨立的 docker-compose 執行檔。
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const composeFile = path.join(repoRoot, 'docker-compose.status.yml')
const statusUp = path.join(repoRoot, 'ops/status-up.sh')

type Volume = { type: string; source?: string; target: string; read_only?: boolean }
type Service = {
  image?: string
  ports?: unknown[]
  mem_limit?: string | number
  network_mode?: string
  privileged?: boolean
  pid?: string
  environment?: Record<string, string | null>
  volumes?: Volume[]
  networks?: Record<string, unknown>
}
type Config = {
  name: string
  services: Record<string, Service>
  networks: Record<string, { name?: string; external?: boolean; internal?: boolean }>
  volumes: Record<string, { name?: string; external?: boolean }>
}

let tmp: string
let config: Config

function composeConfig(env: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  const bin = process.env.DOCKER_COMPOSE_BIN
  const args = ['-f', composeFile, 'config', '--format', 'json']
  return bin
    ? spawnSync(bin, args, { encoding: 'utf8', env })
    : spawnSync('docker', ['compose', ...args], { encoding: 'utf8', env })
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'status-compose-'))
  // env_file 必須存在 compose config 才跑得動；放假的值（不是任何真秘密）。
  fs.writeFileSync(path.join(tmp, 'status.env'), 'ACCESS_TEAM_DOMAIN=example.cloudflareaccess.com\nACCESS_AUD=fakeaud\n')
  fs.writeFileSync(path.join(tmp, 'pghero.env'), 'DATABASE_URL=postgres://fju_monitor:fake@fju-test-postgres:5432/fju\n')
  const r = composeConfig({ PATH: process.env.PATH, HOME: tmp, FJU_STATUS_SECRETS: tmp })
  if (r.error || r.status !== 0) {
    throw new Error(
      `docker compose config 失敗（需要 docker compose，或設 DOCKER_COMPOSE_BIN）：${r.error?.message ?? r.stderr}`,
    )
  }
  config = JSON.parse(r.stdout) as Config
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const svc = (name: string): Service => {
  const s = config.services[name]
  if (!s) throw new Error(`沒有服務 ${name}`)
  return s
}
const networksOf = (name: string) => Object.keys(svc(name).networks ?? {}).sort()
const mounts = (name: string) =>
  (svc(name).volumes ?? []).map((v) => ({
    Type: v.type,
    Source: v.source,
    Destination: v.target,
    RW: !v.read_only,
  }))

describe('docker-compose.status.yml', () => {
  it('project 名是 fju-status，服務齊全', () => {
    expect(config.name).toBe('fju-status')
    expect(Object.keys(config.services).sort()).toEqual(
      ['beszel', 'beszel-agent', 'cloudflared', 'collector', 'docker-proxy', 'dozzle', 'gatus', 'pghero', 'status-web'].sort(),
    )
  })

  it('任何服務都不發布 port', () => {
    for (const [name, s] of Object.entries(config.services)) {
      expect(s.ports, `${name} 不能有 ports`).toBeUndefined()
    }
  })

  it('每個服務都有 mem_limit，且合計不超過 1.3 GB（§3.7）', () => {
    let total = 0
    for (const [name, s] of Object.entries(config.services)) {
      expect(s.mem_limit, `${name} 沒有 mem_limit`).toBeTruthy()
      total += Number(s.mem_limit)
    }
    expect(total).toBeLessThanOrEqual(1.3 * 1024 ** 3)
  })

  it('映像一律固定版本（不用 latest）；自己的映像只能是 main 或完整 SHA', () => {
    for (const [name, s] of Object.entries(config.services)) {
      const image = s.image ?? ''
      if (image.startsWith('ghcr.io/roy4222/fju-status:')) {
        expect(image, name).toMatch(/^ghcr\.io\/roy4222\/fju-status:(main|[0-9a-f]{40})$/)
      } else {
        expect(image, name).toMatch(/^[a-z0-9./-]+:v?\d+\.\d+\.\d+$/)
      }
    }
  })

  it('沒有 privileged、network_mode: host、pid: host；沒有服務掛整個 /', () => {
    for (const [name, s] of Object.entries(config.services)) {
      expect(s.privileged, name).toBeFalsy()
      expect(s.network_mode, name).toBeUndefined()
      expect(s.pid, name).toBeUndefined()
      for (const v of s.volumes ?? []) expect(v.source, `${name} 掛了 /`).not.toBe('/')
    }
  })

  it('只有 docker-proxy 掛 docker.sock，而且它只掛這一項', () => {
    for (const [name, s] of Object.entries(config.services)) {
      const hasSock = (s.volumes ?? []).some((v) => (v.source ?? '').includes('docker.sock'))
      expect(hasSock, `${name} 掛了 docker.sock`).toBe(name === 'docker-proxy')
    }
    expect(mounts('docker-proxy')).toEqual([
      { Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', RW: false },
    ])
  })

  it('docker-proxy 只接 internal 網路 fju-status-docker', () => {
    expect(networksOf('docker-proxy')).toEqual(['fju-status-docker'])
    expect(config.networks['fju-status-docker']).toMatchObject({ name: 'fju-status-docker', internal: true })
    const members = Object.keys(config.services).filter((n) => networksOf(n).includes('fju-status-docker'))
    expect(members.sort()).toEqual(['beszel-agent', 'docker-proxy', 'dozzle'])
  })

  it('beszel-agent：不掛 socket、不用 host 網路、LISTEN 是 socket 路徑、走 docker-proxy', () => {
    const a = svc('beszel-agent')
    expect(a.network_mode).toBeUndefined()
    expect(a.environment?.LISTEN).toBe('/beszel_socket/beszel.sock')
    expect(a.environment?.DOCKER_HOST).toBe('tcp://docker-proxy:2375')
    expect(networksOf('beszel-agent')).toEqual(['fju-status-docker'])
  })

  it('beszel-agent 掛載白名單恰好三項（Type、Source、Destination、RW 四欄）', () => {
    const want = [
      { Type: 'bind', Source: '/srv/fju/status/diskprobe', Destination: '/extra-filesystems/root', RW: false },
      { Type: 'volume', Source: 'beszel_socket', Destination: '/beszel_socket', RW: true },
      { Type: 'volume', Source: 'beszel_agent_data', Destination: '/var/lib/beszel-agent', RW: true },
    ]
    const byDest = (a: { Destination: string }, b: { Destination: string }) => a.Destination.localeCompare(b.Destination)
    expect(mounts('beszel-agent').sort(byDest)).toEqual(want.sort(byDest))
    // docker inspect 的 Mounts[].Name 會是這兩個名字（不帶 project 前綴）
    expect(config.volumes.beszel_socket?.name).toBe('beszel_socket')
    expect(config.volumes.beszel_agent_data?.name).toBe('beszel_agent_data')
    // hub 也掛同一個 socket volume
    expect(mounts('beszel')).toContainEqual({
      Type: 'volume',
      Source: 'beszel_socket',
      Destination: '/beszel_socket',
      RW: true,
    })
  })

  it('dozzle：不掛任何東西、走 docker-proxy、關掉動作與 shell、forward-proxy 身分', () => {
    const d = svc('dozzle')
    expect(d.volumes ?? []).toEqual([])
    expect(d.environment).toMatchObject({
      DOCKER_HOST: 'tcp://docker-proxy:2375',
      DOZZLE_ENABLE_ACTIONS: 'false',
      DOZZLE_ENABLE_SHELL: 'false',
      DOZZLE_AUTH_PROVIDER: 'forward-proxy',
      DOZZLE_AUTH_HEADER_USER: 'Cf-Access-Authenticated-User-Email',
    })
    expect(networksOf('dozzle')).toEqual(['fju-status', 'fju-status-docker'])
  })

  it('pghero 只額外接測試站的 fju-test_default，沒有任何服務接正式站網路', () => {
    expect(networksOf('pghero')).toEqual(['fju-status', 'fju-test'])
    expect(config.networks['fju-test']).toMatchObject({ name: 'fju-test_default', external: true })
    const external = Object.values(config.networks).filter((n) => n.external)
    expect(external.map((n) => n.name)).toEqual(['fju-test_default'])
    for (const [name] of Object.entries(config.services)) {
      if (name !== 'pghero') expect(networksOf(name), name).not.toContain('fju-test')
    }
  })

  it('主網站目錄全部唯讀掛；只有 collector 的 /data 可寫', () => {
    for (const [name, s] of Object.entries(config.services)) {
      for (const v of s.volumes ?? []) {
        if (v.type !== 'bind' || !(v.source ?? '').startsWith('/srv/fju/')) continue
        const writable = !v.read_only
        const allowed = name === 'collector' && v.source === '/srv/fju/status/data' && v.target === '/data'
        expect(writable && !allowed, `${name} 可寫掛了 ${v.source}`).toBe(false)
      }
    }
  })

  it('cloudflared 讀產生器產的 config.yml 與 tunnel.json（唯讀）', () => {
    const m = mounts('cloudflared')
    expect(m).toContainEqual({
      Type: 'bind',
      Source: path.join(repoRoot, 'ops/status/cloudflared.yml'),
      Destination: '/etc/cloudflared/config.yml',
      RW: false,
    })
    expect(m.find((x) => x.Destination === '/etc/cloudflared/tunnel.json')?.RW).toBe(false)
  })
})

// ---- ops/status-up.sh ----

const CONTAINER_PSQL = `sh -c 'psql -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'`

function runUp(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync('bash', [statusUp, ...args], { encoding: 'utf8', env })
}

describe('ops/status-up.sh', () => {
  it('語法正確、--help 結束碼 0、不認得的參數結束碼非 0', () => {
    expect(spawnSync('bash', ['-n', statusUp]).status).toBe(0)
    expect(runUp(['--help'], { PATH: '/usr/bin:/bin' }).status).toBe(0)
    expect(runUp(['--bogus'], { PATH: '/usr/bin:/bin' }).status).not.toBe(0)
  })

  it('AC-S-24(a)：乾淨環境 --ensure-db-role-only --dry-run 印出的指令含原文 "$POSTGRES_USER"', () => {
    // 沒有任何 POSTGRES_*、FJU_*、DOPPLER_* 變數。
    const r = runUp(['--ensure-db-role-only', '--dry-run'], { PATH: '/usr/bin:/bin' })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain(`docker exec -i fju-test-postgres ${CONTAINER_PSQL}`)
    expect(r.stdout).toContain('"$POSTGRES_USER"')
    expect(r.stdout).toContain('"$POSTGRES_DB"')
    expect(r.stdout).not.toMatch(/site\.sh|doppler/i)
    expect(r.stdout).toContain("ALTER ROLE fju_monitor LOGIN PASSWORD '********'")
    expect(r.stdout).toContain('GRANT pg_monitor TO fju_monitor')
  })

  describe('實跑（假的 docker：exec 時用「容器裡」的環境跑 sh -c）', () => {
    let dir: string
    let bin: string
    let secrets: string
    let log: string

    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-up-'))
      bin = path.join(dir, 'bin')
      secrets = path.join(dir, 'secrets')
      log = path.join(dir, 'log')
      fs.mkdirSync(bin)
      fs.mkdirSync(secrets)
      fs.mkdirSync(log)
      // 假 docker：inspect 依 FAKE_PG_RUNNING 回 true／false；exec 記下參數，
      // 再把剩下的參數交給 env 跑，只給「容器裡」才有的 POSTGRES_USER／POSTGRES_DB。
      fs.writeFileSync(
        path.join(bin, 'docker'),
        `#!/bin/bash
printf '%s\\n' "$*" >> "$FAKE_LOG/docker-calls"
case "$1" in
  inspect) echo "\${FAKE_PG_RUNNING:-true}" ;;
  exec)
    shift
    [ "$1" = -i ] && shift
    shift
    printf '%s\\n' "$@" > "$FAKE_LOG/exec-argv-$(date +%s%N)"
    exec env -i PATH="$FAKE_BIN:/usr/bin:/bin" FAKE_LOG="$FAKE_LOG" FAKE_ROLE_EXISTS="$FAKE_ROLE_EXISTS" \\
      POSTGRES_USER=owner_in_container POSTGRES_DB=db_in_container "$@"
    ;;
  *) exit 0 ;;
esac
`,
        { mode: 0o755 },
      )
      // 假 psql：記下參數與 stdin；查詢模式（-tA）依 FAKE_ROLE_EXISTS 回 1 或空。
      fs.writeFileSync(
        path.join(bin, 'psql'),
        `#!/bin/bash
printf '%s\\n' "$*" >> "$FAKE_LOG/psql-argv"
cat >> "$FAKE_LOG/psql-stdin"
case " $* " in *" -tA "*) [ "$FAKE_ROLE_EXISTS" = 1 ] && echo 1 ;; esac
exit 0
`,
        { mode: 0o755 },
      )
      fs.writeFileSync(path.join(secrets, 'pghero.env'), "DATABASE_URL=postgres://x\nFJU_MONITOR_PASSWORD=pa'ss-FAKE\n")
    })

    afterAll(() => {
      fs.rmSync(dir, { recursive: true, force: true })
    })

    const env = (extra: Record<string, string>) => ({
      PATH: `${bin}:/usr/bin:/bin`,
      FAKE_LOG: log,
      FAKE_BIN: bin,
      FJU_STATUS_SECRETS: secrets,
      ...extra,
    })
    const reset = () => {
      for (const f of fs.readdirSync(log)) fs.rmSync(path.join(log, f))
    }
    const read = (f: string) => fs.readFileSync(path.join(log, f), 'utf8')

    it('角色不在：印「補建 fju_monitor」，帳號在容器裡展開，密碼單引號雙寫且不印出來', () => {
      reset()
      const r = runUp(['--ensure-db-role-only'], env({ FAKE_ROLE_EXISTS: '0' }))
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('補建 fju_monitor')
      expect(r.stdout + r.stderr).not.toContain('FAKE')
      // docker 收到的是原文 "$POSTGRES_USER"（外層沒展開）
      const calls = read('docker-calls')
      expect(calls).toContain(`exec -i fju-test-postgres ${CONTAINER_PSQL.replace(/'/g, '')}`)
      // 在「容器裡」才展開成容器的值
      expect(read('psql-argv')).toContain('-U owner_in_container -d db_in_container')
      const sql = read('psql-stdin')
      expect(sql).toContain("ALTER ROLE fju_monitor LOGIN PASSWORD 'pa''ss-FAKE';")
      expect(sql).toContain('CREATE ROLE fju_monitor')
      expect(sql).toContain('GRANT pg_monitor TO fju_monitor')
      expect(sql).toContain("format('GRANT CONNECT ON DATABASE %I TO fju_monitor', current_database())")
      expect(sql).not.toMatch(/GRANT\s+(SELECT|ALL|INSERT|UPDATE|DELETE)/i)
    })

    it('角色已在：同步密碼與權限，不說「補建」', () => {
      reset()
      const r = runUp(['--ensure-db-role-only'], env({ FAKE_ROLE_EXISTS: '1' }))
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('fju_monitor 已在')
      expect(r.stdout).not.toContain('補建 fju_monitor（')
    })

    it('測試站 postgres 不在（重置中）：印「跳過」、結束碼 0、不 exec', () => {
      reset()
      const r = runUp(['--ensure-db-role-only'], env({ FAKE_PG_RUNNING: 'false' }))
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('跳過：測試站 postgres 不在')
      expect(read('docker-calls')).not.toContain('exec')
    })

    it('pghero.env 沒有密碼：結束碼非 0、不 exec', () => {
      reset()
      const empty = path.join(dir, 'empty-secrets')
      fs.mkdirSync(empty, { recursive: true })
      const r = runUp(['--ensure-db-role-only'], { ...env({}), FJU_STATUS_SECRETS: empty })
      expect(r.status).not.toBe(0)
      expect(read('docker-calls')).not.toContain('exec')
    })

    it.runIf(!fs.existsSync(path.join(repoRoot, 'ops/status/cloudflared.yml')))(
      '還沒產生 cloudflared.yml：不起服務、結束碼非 0（免得 docker 把掛載來源建成空目錄）',
      () => {
        reset()
        const r = runUp([], env({}))
        expect(r.status).not.toBe(0)
        expect(r.stderr).toContain('status-render-cloudflared.sh')
        expect(fs.existsSync(path.join(log, 'docker-calls'))).toBe(false)
      },
    )
  })
})
