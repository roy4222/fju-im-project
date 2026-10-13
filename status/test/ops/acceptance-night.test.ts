// ops/acceptance-night.sh --plan ux（只跑人設）：還原學期中快照、沿用 midterm.pw。
// 真的跑整支腳本，只把外部換成假的：ssh（記下子命令；status 印 FAKE_SNAPSHOTS）、doppler、codex-e2e.sh（記下項目與拿到的密碼）、
// playwright-cli；清單、run 目錄、HOME 都在暫存目錄。不連網、不碰真的 fju-reset。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const script = path.join(repoRoot, 'ops/acceptance-night.sh')

const UX_IDS = [
  'ux-admin-midterm', 'ux-leader', 'ux-member', 'ux-ungrouped',
  'ux-grader', 'ux-advisor', 'ux-freshman', 'ux-visitor-highschool',
  'ux-visitor-industry', 'ux-admin-newbie',
]
const LISTS = [
  'personas/admin-midterm.md', 'personas/leader.md', 'personas/member.md', 'personas/ungrouped.md',
  'personas/grader.md', 'personas/advisor.md', 'personas/freshman.md', 'personas/visitor-highschool.md',
  'personas/visitor-industry.md', 'personas/admin-newbie.md', 'r1-login-rate-limit.md',
]
const MIDTERM_PW = 'MidtermSnapPw0123456789x'

// 真的跑腳本（看門狗每項至少睡 1 秒、收尾還要連假健康檢查）：整套一起跑時機器忙，預設 5 秒不夠。
vi.setConfig({ testTimeout: 30_000 })

let tmp: string
let home: string
let outRoot: string
let calls: string

function exe(file: string, body: string) {
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 })
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-ux-'))
  home = path.join(tmp, 'home')
  outRoot = path.join(tmp, 'out')
  calls = path.join(tmp, 'calls')
  fs.mkdirSync(home)
  fs.mkdirSync(calls)
  const bin = path.join(tmp, 'bin')
  fs.mkdirSync(bin)
  exe(path.join(bin, 'ssh'), `echo "$*" >> "${calls}/ssh"
if [ "$2" = status ]; then echo "snapshots=\${FAKE_SNAPSHOTS:-}"; echo "last_run=restore midterm"; fi
exit 0`)
  exe(path.join(bin, 'doppler'), 'echo fake-admin-pw-0000')
  exe(path.join(tmp, 'pwcli'), 'exit 0')
  // 記項目與拿到的密碼到 run 目錄外（收尾只遮蔽 run 目錄）
  exe(path.join(tmp, 'codex-e2e'), `echo "$ACCEPT_ITEM $ACCEPT_PASSWORD" >> "${calls}/codex"`)
  const e2eRoot = path.join(tmp, 'e2e')
  for (const l of LISTS) {
    fs.mkdirSync(path.dirname(path.join(e2eRoot, l)), { recursive: true })
    fs.writeFileSync(path.join(e2eRoot, l), '# 假清單\n')
  }
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function writeMidtermPw(content = `${MIDTERM_PW}\n`, mode = 0o600) {
  const dir = path.join(home, '.fju-acceptance/snapshots')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, 'midterm.pw')
  fs.writeFileSync(file, content)
  fs.chmodSync(file, mode)
  return file
}

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    timeout: 90_000,
    env: {
      NODE_ENV: 'test',
      PATH: `${path.join(tmp, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: home,
      TMPDIR: tmp,
      ACCEPT_E2E_ROOT: path.join(tmp, 'e2e'),
      ACCEPT_OUT_ROOT: outRoot,
      ACCEPT_CODEX_E2E: path.join(tmp, 'codex-e2e'),
      PWCLI: path.join(tmp, 'pwcli'),
      ACCEPT_HEALTH_URL: 'http://127.0.0.1:9/api/health',
      ACCEPT_RESET_GAP: '0',
      ACCEPT_BUDGET_OVERRIDE: '30s',
      ACCEPT_UX_DEADLINE: `@${Math.floor(Date.now() / 1000) + 3600}`,
      ACCEPT_STATUS_PUBLISH: '0',
      FAKE_SNAPSHOTS: 'midterm',
      ...env,
    },
  })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

function lines(name: string) {
  const f = path.join(calls, name)
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n') : []
}

function onlyNight() {
  const nights = fs.existsSync(outRoot) ? fs.readdirSync(outRoot) : []
  expect(nights).toHaveLength(1)
  return path.join(outRoot, nights[0]!)
}

describe('acceptance-night.sh --plan ux --dry-run', () => {
  it('印出完整順序：檢查 midterm.pw → status → pause-deploy → restore midterm → 三批 → r1 → resume-deploy、不刪 snapshots/', () => {
    const r = run(['--plan', 'ux', '--dry-run'])
    expect(r.code, r.stderr).toBe(0)
    const o = r.stdout
    const order = [
      'snapshots/midterm.pw 存在、非空、權限 600',
      'ssh fju-reset status',
      'ssh fju-reset pause-deploy',
      'ssh fju-reset restore midterm',
      '不產新密碼',
      '第 1 批（同時，最多 4 個、最多 1 個系辦）：ux-admin-midterm ux-leader ux-member ux-ungrouped',
      '第 2 批（同時，最多 4 個、最多 1 個系辦）：ux-grader ux-advisor ux-freshman ux-visitor-highschool',
      '第 3 批（同時，最多 4 個、最多 1 個系辦）：ux-visitor-industry ux-admin-newbie',
      '最後（UX 全部結束後；一項一項跑，不並行）：r1-login-limit',
      'ssh fju-reset resume-deploy',
      '不刪',
      '--polish',
    ].map((s) => o.indexOf(s))
    expect(order.every((i) => i >= 0), o).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // 不跑劇本、不 reset、不存快照
    expect(o).not.toMatch(/story-\d/)
    expect(o).not.toMatch(/fju-reset reset\b/)
    expect(o).not.toContain('snapshot midterm')
    // dry-run 不建目錄、不連網
    expect(fs.existsSync(outRoot)).toBe(false)
    expect(lines('ssh')).toEqual([])
  })

  it('--no-reset／--no-snapshot 不能和 ux 一起用', () => {
    expect(run(['--plan', 'ux', '--no-reset', '--dry-run']).code).not.toBe(0)
    expect(run(['--plan', 'ux', '--no-snapshot', '--dry-run']).code).not.toBe(0)
  })
})

describe('acceptance-night.sh --plan ux：缺快照就停', () => {
  it('沒有 midterm.pw：停，不 ssh、不跑人設', () => {
    const r = run(['--plan', 'ux'])
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('midterm.pw')
    expect(lines('ssh')).toEqual([])
    expect(lines('codex')).toEqual([])
  })

  it('midterm.pw 是空的：停', () => {
    writeMidtermPw('')
    const r = run(['--plan', 'ux'])
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('空的')
    expect(lines('ssh')).toEqual([])
  })

  it('midterm.pw 權限不是 600：停', () => {
    writeMidtermPw(`${MIDTERM_PW}\n`, 0o644)
    const r = run(['--plan', 'ux'])
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('600')
    expect(lines('ssh')).toEqual([])
  })

  it('status 的 snapshots= 沒有 midterm：停在 status，不 pause、不 restore、不跑人設；midterm.pw 留著', () => {
    const pw = writeMidtermPw()
    const r = run(['--plan', 'ux'], { FAKE_SNAPSHOTS: 'other' })
    expect(r.code).not.toBe(0)
    expect(lines('ssh')).toEqual(['fju-reset status'])
    expect(lines('codex')).toEqual([])
    const log = fs.readFileSync(path.join(onlyNight(), 'run.log'), 'utf8')
    expect(log).toContain('沒有 midterm')
    expect(fs.readFileSync(pw, 'utf8')).toBe(`${MIDTERM_PW}\n`)
  })
})

describe('acceptance-night.sh --plan ux：有快照', () => {
  it('順序正確、每項拿到的是 midterm.pw、收尾刪本次秘密但留 snapshots/', () => {
    const pw = writeMidtermPw()
    const r = run(['--plan', 'ux'])
    expect(r.code, r.stdout + r.stderr).toBe(0)

    expect(lines('ssh')).toEqual(['fju-reset status', 'fju-reset pause-deploy', 'fju-reset restore midterm', 'fju-reset resume-deploy'])

    const codex = lines('codex').map((l) => l.split(' '))
    const items = codex.map(([id]) => id)
    expect([...items].sort()).toEqual([...UX_IDS, 'r1-login-limit'].sort())
    // 批次順序：第 1 批全在第 2 批前、第 2 批全在第 3 批前，r1 最後
    const at = (id: string) => items.indexOf(id)
    const batches = [UX_IDS.slice(0, 4), UX_IDS.slice(4, 8), UX_IDS.slice(8)]
    expect(Math.max(...batches[0]!.map(at))).toBeLessThan(Math.min(...batches[1]!.map(at)))
    expect(Math.max(...batches[1]!.map(at))).toBeLessThan(Math.min(...batches[2]!.map(at)))
    expect(items.at(-1)).toBe('r1-login-limit')
    // 沿用快照密碼，不產新的
    expect(new Set(codex.map(([, p]) => p))).toEqual(new Set([MIDTERM_PW]))

    const night = onlyNight()
    const runJson = JSON.parse(fs.readFileSync(path.join(night, 'run.json'), 'utf8'))
    expect(runJson.plan).toBe('ux')
    expect(runJson.items.map((i: { status: string }) => i.status)).toEqual(Array(11).fill('ok'))
    const log = fs.readFileSync(path.join(night, 'run.log'), 'utf8')
    expect(log).toContain('restore midterm ok')
    expect(log).not.toMatch(/story-\d/)

    // 本次秘密目錄刪了，snapshots/midterm.pw 原封不動
    const secrets = fs.readdirSync(path.join(home, '.fju-acceptance'))
    expect(secrets).toEqual(['snapshots'])
    expect(fs.readFileSync(pw, 'utf8')).toBe(`${MIDTERM_PW}\n`)
    expect(fs.statSync(pw).mode & 0o777).toBe(0o600)
  }, 90_000)
})
