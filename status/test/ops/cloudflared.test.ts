// 隧道設定產生器 ops/status-render-cloudflared.sh（設計方案 §3.2a；AC-S-25 a）。
// 四條 ingress 都要有 originRequest.access（required: true、teamName＝team 名稱、audTag＝AUD）；
// 同一個斷言對「拿掉 access」的設定必須失敗，證明斷言分得出有鎖沒鎖。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Next 的型別把 NODE_ENV 設成 ProcessEnv 的必填；子程序刻意給乾淨環境，所以用寬鬆的型別再轉。
type Env = Record<string, string | undefined>

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const render = path.join(repoRoot, 'ops/status-render-cloudflared.sh')

const TEAM = 'fake-team'
const AUD = 'a'.repeat(32) + '0123456789abcdef0123456789abcdef'
const TUNNEL_ID = '12345678-90ab-cdef-1234-567890abcdef'
const HOSTS = [
  'fju-status.roy422.dev',
  'fju-status-vm.roy422.dev',
  'fju-status-logs.roy422.dev',
  'fju-status-db.roy422.dev',
]

type Ingress = {
  hostname?: string
  service: string
  originRequest?: { access?: { required?: unknown; teamName?: unknown; audTag?: unknown } }
}
type CloudflaredConfig = { tunnel: string; 'credentials-file': string; ingress: Ingress[] }

/** 每條有 hostname 的 ingress 都要帶隧道端 JWT 鎖；四個網址都要在；最後一條是 404。 */
function assertAccess(cfg: CloudflaredConfig, team: string, aud: string, hosts: string[]): void {
  const rules = cfg.ingress.filter((r) => r.hostname !== undefined)
  const got = rules.map((r) => r.hostname)
  if (JSON.stringify([...got].sort()) !== JSON.stringify([...hosts].sort())) {
    throw new Error(`ingress 網址不對：${got.join(', ')}`)
  }
  for (const r of rules) {
    const a = r.originRequest?.access
    if (!a) throw new Error(`${r.hostname} 沒有 originRequest.access`)
    if (a.required !== true) throw new Error(`${r.hostname} 的 access.required 不是 true`)
    if (a.teamName !== team) throw new Error(`${r.hostname} 的 teamName 不是 ${team}`)
    if (!Array.isArray(a.audTag) || a.audTag.length !== 1 || a.audTag[0] !== aud) {
      throw new Error(`${r.hostname} 的 audTag 不是 [AUD]`)
    }
  }
  const last = cfg.ingress[cfg.ingress.length - 1]
  if (!last || last.hostname !== undefined || last.service !== 'http_status:404') {
    throw new Error('最後一條必須是不帶 hostname 的 http_status:404')
  }
}

let tmp: string

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'status-cloudflared-'))
})
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function run(args: string[], env: Env = {}) {
  const full: Env = { PATH: '/usr/bin:/bin', ...env }
  return spawnSync('bash', [render, ...args], { encoding: 'utf8', env: full as NodeJS.ProcessEnv })
}
function renderTo(name: string, extra: string[] = [], env: Env = {}) {
  const out = path.join(tmp, name)
  const r = run(['--team', `${TEAM}.cloudflareaccess.com`, '--aud', AUD, '--tunnel-id', TUNNEL_ID, '--out', out, ...extra], env)
  return { r, out }
}
const load = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as CloudflaredConfig

describe('ops/status-render-cloudflared.sh', () => {
  it('產生四條 ingress，每條都有 access，斷言通過', () => {
    const { r, out } = renderTo('ok.yml')
    expect(r.status).toBe(0)
    const cfg = load(out)
    expect(() => assertAccess(cfg, TEAM, AUD, HOSTS)).not.toThrow()
    expect(cfg.tunnel).toBe(TUNNEL_ID)
    expect(cfg['credentials-file']).toBe('/etc/cloudflared/tunnel.json')
    expect(cfg.ingress.map((x) => [x.hostname, x.service])).toEqual([
      ['fju-status.roy422.dev', 'http://status-web:3000'],
      ['fju-status-vm.roy422.dev', 'http://beszel:8090'],
      ['fju-status-logs.roy422.dev', 'http://dozzle:8080'],
      ['fju-status-db.roy422.dev', 'http://pghero:8080'],
      [undefined, 'http_status:404'],
    ])
    expect(fs.statSync(out).mode & 0o777).toBe(0o644)
  })

  it('拿掉 access 的設定（--no-access 產的樣本）讓斷言失敗', () => {
    const { r, out } = renderTo('no-access.yml', ['--no-access'])
    expect(r.status).toBe(0)
    expect(() => assertAccess(load(out), TEAM, AUD, HOSTS)).toThrow(/沒有 originRequest\.access/)
  })

  it('只拿掉其中一條的 access、required 改 false、AUD 錯、teamName 帶網域：斷言都失敗', () => {
    const { out } = renderTo('base.yml')
    const mutate = (f: (c: CloudflaredConfig) => void) => {
      const c = load(out)
      f(c)
      return () => assertAccess(c, TEAM, AUD, HOSTS)
    }
    expect(mutate((c) => delete c.ingress[2]!.originRequest)).toThrow(/fju-status-logs.*沒有/)
    expect(mutate((c) => (c.ingress[0]!.originRequest!.access!.required = false))).toThrow(/required/)
    expect(mutate((c) => (c.ingress[1]!.originRequest!.access!.audTag = ['wrong']))).toThrow(/audTag/)
    expect(mutate((c) => (c.ingress[3]!.originRequest!.access!.teamName = `${TEAM}.cloudflareaccess.com`))).toThrow(
      /teamName/,
    )
    expect(mutate((c) => c.ingress.pop())).toThrow(/404/)
    expect(mutate((c) => c.ingress.splice(1, 1))).toThrow(/網址不對/)
  })

  it('--credentials 從 tunnel.json 讀隧道 ID', () => {
    const cred = path.join(tmp, 'tunnel.json')
    fs.writeFileSync(cred, JSON.stringify({ AccountTag: 'x', TunnelSecret: 'FAKE', TunnelID: TUNNEL_ID }))
    const out = path.join(tmp, 'cred.yml')
    const r = run(['--team', TEAM, '--aud', AUD, '--credentials', cred, '--out', out])
    expect(r.status).toBe(0)
    const cfg = load(out)
    expect(cfg.tunnel).toBe(TUNNEL_ID)
    expect(fs.readFileSync(out, 'utf8')).not.toContain('FAKE')
    expect(() => assertAccess(cfg, TEAM, AUD, HOSTS)).not.toThrow()
  })

  it('STATUS_HOSTS 是唯一的網址設定：覆寫後 ingress 跟著變；--print-hosts 依序印出', () => {
    const hosts = ['a.example.dev', 'b.example.dev', 'c.example.dev', 'd.example.dev']
    const { r, out } = renderTo('hosts.yml', [], { STATUS_HOSTS: hosts.join(' ') })
    expect(r.status).toBe(0)
    expect(() => assertAccess(load(out), TEAM, AUD, hosts)).not.toThrow()
    expect(run(['--print-hosts']).stdout.trim().split('\n')).toEqual(HOSTS)
  })

  it.each([
    ['缺 --aud', ['--team', TEAM, '--tunnel-id', TUNNEL_ID], {}],
    ['缺 --team', ['--aud', AUD, '--tunnel-id', TUNNEL_ID], {}],
    ['缺隧道 ID', ['--team', TEAM, '--aud', AUD], {}],
    ['team 有引號', ['--team', 'a"b', '--aud', AUD, '--tunnel-id', TUNNEL_ID], {}],
    ['AUD 有引號', ['--team', TEAM, '--aud', `${AUD}"x`, '--tunnel-id', TUNNEL_ID], {}],
    ['隧道 ID 格式錯', ['--team', TEAM, '--aud', AUD, '--tunnel-id', 'nope'], {}],
    ['STATUS_HOSTS 只有三個', ['--team', TEAM, '--aud', AUD, '--tunnel-id', TUNNEL_ID], { STATUS_HOSTS: 'a.dev b.dev c.dev' }],
    ['網址有怪字元', ['--team', TEAM, '--aud', AUD, '--tunnel-id', TUNNEL_ID], { STATUS_HOSTS: 'a.dev b.dev c.dev "d.dev' }],
  ] as const)('%s：結束碼非 0、不產生檔案', (_name, args, env) => {
    const out = path.join(tmp, `bad-${Math.random().toString(36).slice(2)}.yml`)
    const r = run([...args, '--out', out], env)
    expect(r.status).not.toBe(0)
    expect(fs.existsSync(out)).toBe(false)
  })

  it('語法正確、--help 結束碼 0', () => {
    expect(spawnSync('bash', ['-n', render]).status).toBe(0)
    expect(run(['--help']).status).toBe(0)
  })
})
