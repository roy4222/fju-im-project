// AC-S-22：ops/status-publish-run.sh 把一夜驗收結果送上開發者後台。
// 用真的 rsync，只把 ssh 換成假的：假 ssh 記下連線次數，然後在「VM inbox」目錄裡執行遠端那半邊的 rsync
// （等同 rrsync -wo 把路徑限制在 inbox）。所以落地權限、--delete、送了哪些檔都是真的 rsync 行為。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const script = path.join(repoRoot, 'ops/status-publish-run.sh')
const nightScript = path.join(repoRoot, 'ops/acceptance-night.sh')

let tmp: string
let outRoot: string
let mirror: string
let inbox: string
let fakeSsh: string

const OLD_NIGHTS = ['night-20261001-2200', 'night-20261002-2200', 'night-20261003-2200', 'night-20261004-2200', 'night-20261005-2200']

function write(file: string, content: string, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, content, { mode })
}

function runJson(runId: string) {
  return JSON.stringify({ runId, plan: 'full', startedAt: '', finishedAt: '', commitStart: 'abcdef12', commitEnd: 'abcdef12', items: [] })
}

// 一夜 run 目錄：檔案 600、目錄 700（同 Mac 上 acceptance-night.sh 產出的樣子）。
function makeNight(runId: string, opts: { summary?: unknown; extra?: boolean } = {}) {
  const dir = path.join(outRoot, runId)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  write(path.join(dir, 'run.json'), runJson(runId))
  if (opts.summary !== undefined) write(path.join(dir, 'summary.json'), JSON.stringify(opts.summary))
  if (opts.extra) {
    write(path.join(dir, 'report.md'), '# 報告\n')
    write(path.join(dir, 'summary.md'), '# 總覽\n')
    write(path.join(dir, 'run.log'), 'log\n')
    write(path.join(dir, 'logs/story-1.log'), 'someone@example.com 提示詞\n')
    write(path.join(dir, '.playwright-cli/state.json'), '{}\n')
    write(path.join(dir, 'story-1/report.md'), '# story-1\n')
    write(path.join(dir, 'story-1/progress.md'), '進度\n')
    for (let i = 0; i < 300; i++) write(path.join(dir, `story-1/screenshots/extra-${i}.png`), 'png')
  }
  return dir
}

// summary.json 列到 12 張：story-1 六張、story-2 四張、ux 兩張（jpg、webp）。
const LISTED = [
  ...Array.from({ length: 6 }, (_, i) => `story-1/screenshots/s1-${i}.png`),
  ...Array.from({ length: 4 }, (_, i) => `story-2/screenshots/s2-${i}.png`),
  'ux-visitor-highschool/screenshots/home.jpg',
  'ux-visitor-highschool/screenshots/menu.webp',
]

function summaryListing(shots: string[]) {
  const byItem = new Map<string, string[]>()
  for (const s of shots) {
    const id = s.split('/')[0]!
    byItem.set(id, [...(byItem.get(id) ?? []), s])
  }
  return {
    runId: 'x',
    items: [...byItem].map(([id, list]) => ({
      id,
      // 同一張圖出現在兩步也只送一次
      steps: [
        { 步驟: '1', 截圖: list },
        { 步驟: '2', 截圖: list.slice(0, 1) },
        { 步驟: '3', 截圖: [] },
      ],
      problems: [],
    })),
  }
}

function seedOldNights() {
  for (const n of OLD_NIGHTS) {
    write(path.join(mirror, n, 'run.json'), runJson(n), 0o644)
    write(path.join(inbox, n, 'run.json'), runJson(n), 0o644)
  }
}

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [script, ...args], {
    cwd: tmp,
    encoding: 'utf8',
    env: {
      NODE_ENV: 'test',
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: tmp,
      STATUS_PUBLISH_SSH: fakeSsh,
      STATUS_PUBLISH_MIRROR: mirror,
      STATUS_PUBLISH_OUT_ROOT: outRoot,
      ...env,
    },
  })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, all: r.stdout + r.stderr }
}

const sshCalls = () => {
  const f = path.join(tmp, 'ssh-calls')
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : []
}

// inbox 底下所有東西（相對路徑），目錄結尾加 /
function tree(root: string): string[] {
  const out: string[] = []
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        out.push(`${r}/`)
        walk(path.join(d, e.name), r)
      } else out.push(r)
    }
  }
  walk(root, '')
  return out.sort()
}

const mode = (p: string) => fs.statSync(p).mode & 0o777

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fju-publish-'))
  outRoot = path.join(tmp, 'out')
  mirror = path.join(tmp, 'mirror')
  inbox = path.join(tmp, 'vm-inbox')
  fs.mkdirSync(outRoot)
  fs.mkdirSync(inbox, { mode: 0o755 })
  fakeSsh = path.join(tmp, 'fake-ssh')
  fs.writeFileSync(
    fakeSsh,
    [
      '#!/usr/bin/env bash',
      '# 假 ssh：記一次連線，跳過 -o 選項，在 inbox 裡跑遠端那半邊（同 rrsync -wo 限制在 inbox）。',
      'while [ "${1:-}" = -o ]; do shift 2; done',
      `echo "$1" >> '${tmp}/ssh-calls'`,
      'shift',
      `cd '${inbox}' && exec sh -c "$*"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('status-publish-run.sh', () => {
  it('bash -n 通過、--help 說明用法', () => {
    expect(spawnSync('bash', ['-n', script]).status).toBe(0)
    const r = run(['--help'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('--dry-run')
    expect(sshCalls()).toEqual([])
  })

  it('--dry-run 只印清單：不連線、不動鏡像與 inbox', () => {
    seedOldNights()
    const dir = makeNight('night-20261012-2200', { summary: summaryListing(LISTED), extra: true })
    for (const s of LISTED) write(path.join(dir, s), 'img')
    const mirrorBefore = tree(mirror)
    const inboxBefore = tree(inbox)

    const r = run([dir, '--dry-run'])
    expect(r.code).toBe(0)
    expect(sshCalls()).toEqual([])
    expect(tree(mirror)).toEqual(mirrorBefore)
    expect(tree(inbox)).toEqual(inboxBefore)
    expect(r.stdout).toContain('run.json')
    expect(r.stdout).toContain('summary.json')
    for (const s of LISTED) expect(r.stdout).toContain(s)
    expect(r.stdout).not.toContain('extra-0.png')
    expect(r.stdout).not.toContain('report.md')
    // 會被擠掉的最舊那夜要講出來
    expect(r.stdout).toContain(OLD_NIGHTS[0])
  })

  it('實跑：只送 run.json＋summary.json＋列到的 12 張，落地 644／755，最舊那夜消失，只連一次', () => {
    seedOldNights()
    const runId = 'night-20261012-2200'
    const dir = makeNight(runId, { summary: summaryListing(LISTED), extra: true })
    for (const s of LISTED) write(path.join(dir, s), 'img')

    const r = run([dir])
    expect(r.code, r.all).toBe(0)
    expect(sshCalls()).toEqual(['fju-status-publish'])

    const nights = fs.readdirSync(inbox).sort()
    expect(nights).toEqual([...OLD_NIGHTS.slice(1), runId])
    expect(fs.readdirSync(mirror).sort()).toEqual([...OLD_NIGHTS.slice(1), runId])

    const files = tree(path.join(inbox, runId)).filter((p) => !p.endsWith('/'))
    expect(files).toEqual(['run.json', 'summary.json', ...LISTED].sort())

    for (const p of tree(inbox)) {
      const full = path.join(inbox, p)
      expect([p, mode(full)]).toEqual([p, p.endsWith('/') ? 0o755 : 0o644])
    }
    expect(fs.readFileSync(path.join(inbox, runId, 'run.json'), 'utf8')).toBe(runJson(runId))
  })

  it('沒有 summary.json 的夜：照樣送 run.json、印警告、結束碼 0', () => {
    const runId = 'night-20261013-2200'
    const dir = makeNight(runId, { extra: true })

    const r = run([dir])
    expect(r.code, r.all).toBe(0)
    expect(r.all).toContain('沒有 summary.json')
    expect(sshCalls()).toHaveLength(1)
    expect(tree(path.join(inbox, runId))).toEqual(['run.json'])
    expect(mode(path.join(inbox, runId, 'run.json'))).toBe(0o644)
  })

  it('run.json 不存在：不連線、結束碼非 0、鏡像不動', () => {
    const dir = path.join(outRoot, 'night-20261014-2200')
    fs.mkdirSync(dir, { recursive: true })
    write(path.join(dir, 'summary.json'), JSON.stringify(summaryListing([])))

    const r = run([dir])
    expect(r.code).not.toBe(0)
    expect(r.all).toContain('run.json')
    expect(sshCalls()).toEqual([])
    expect(fs.existsSync(mirror) ? fs.readdirSync(mirror) : []).toEqual([])
  })

  it('run 目錄不存在：結束碼非 0、不連線', () => {
    const r = run([path.join(outRoot, 'night-nope')])
    expect(r.code).not.toBe(0)
    expect(sshCalls()).toEqual([])
  })

  it('summary.json 列到的路徑不合規（跳出目錄、不是截圖、符號連結、找不到）：不送，其餘照送', () => {
    const runId = 'night-20261015-2200'
    const dir = makeNight(runId, {
      summary: summaryListing([
        'story-1/screenshots/ok.png',
        'story-1/screenshots/../report.md',
        'story-1/screenshots/../../run.log',
        'story-1/screenshots/../../logs/leak.png',
        'story-1/screenshots/../../../outside.png',
        'story-1/report.md',
        'story-1/screenshots/link.png',
        'story-1/screenshots/missing.png',
        'story-1/screenshots/anim.gif',
      ]),
      extra: true,
    })
    write(path.join(dir, 'story-1/screenshots/ok.png'), 'img')
    write(path.join(dir, 'story-1/screenshots/anim.gif'), 'gif')
    write(path.join(dir, 'logs/leak.png'), 'leak')
    write(path.join(outRoot, 'outside.png'), 'outside')
    fs.symlinkSync(path.join(dir, 'logs/story-1.log'), path.join(dir, 'story-1/screenshots/link.png'))

    const r = run([dir])
    expect(r.code, r.all).toBe(0)
    expect(tree(path.join(inbox, runId)).filter((p) => !p.endsWith('/'))).toEqual(['run.json', 'story-1/screenshots/ok.png', 'summary.json'])
    expect(r.all).toContain('missing.png')
  })

  it('summary.json 壞掉：照送 run.json 與 summary.json（讓後台標「不合法」），印警告、結束碼 0', () => {
    const runId = 'night-20261016-2200'
    const dir = makeNight(runId)
    write(path.join(dir, 'summary.json'), '{ 壞掉')

    const r = run([dir])
    expect(r.code, r.all).toBe(0)
    expect(r.all).toContain('summary.json')
    expect(tree(path.join(inbox, runId))).toEqual(['run.json', 'summary.json'])
  })

  it('重送同一夜：鏡像換成這次的清單，VM 上多出來的舊截圖被刪掉', () => {
    const runId = 'night-20261017-2200'
    const dir = makeNight(runId, { summary: summaryListing(['story-1/screenshots/a.png', 'story-1/screenshots/b.png']) })
    write(path.join(dir, 'story-1/screenshots/a.png'), 'a')
    write(path.join(dir, 'story-1/screenshots/b.png'), 'b')
    expect(run([dir]).code).toBe(0)
    write(path.join(dir, 'summary.json'), JSON.stringify(summaryListing(['story-1/screenshots/a.png'])))

    const r = run([dir])
    expect(r.code, r.all).toBe(0)
    expect(tree(path.join(inbox, runId)).filter((p) => !p.endsWith('/'))).toEqual(['run.json', 'story-1/screenshots/a.png', 'summary.json'])
    expect(sshCalls()).toHaveLength(2)
  })

  it('latest：挑 .out 底下最新一個有 run.json 的 night-*', () => {
    makeNight('night-20261010-2200')
    makeNight('night-20261011-2200')
    fs.mkdirSync(path.join(outRoot, 'night-20261012-2200')) // 還沒寫 run.json

    const r = run(['latest', '--dry-run'])
    expect(r.code, r.all).toBe(0)
    expect(r.stdout).toContain('night-20261011-2200')
    expect(sshCalls()).toEqual([])
  })

  it('rsync 失敗（連不上）：結束碼非 0', () => {
    const dir = makeNight('night-20261018-2200')
    fs.writeFileSync(fakeSsh, '#!/usr/bin/env bash\nexit 255\n', { mode: 0o755 })
    const r = run([dir])
    expect(r.code).not.toBe(0)
  })
})

describe('acceptance-night.sh 收尾呼叫推送', () => {
  const src = fs.readFileSync(nightScript, 'utf8')

  it('在 summarize 那段之後、done／interrupted 之前呼叫，失敗只記警告', () => {
    const summarize = src.indexOf('log summarize-missing')
    const publish = src.indexOf('ops/status-publish-run.sh" "$RUN_DIR"')
    const done = src.indexOf('if [ "$reason" = "done" ]; then')
    expect(summarize).toBeGreaterThan(0)
    expect(publish).toBeGreaterThan(summarize)
    expect(done).toBeGreaterThan(publish)
    const block = src.slice(publish - 200, done)
    // 包在 if 裡（set -e 不會因推送失敗中止收尾），失敗那支只 log，不 exit
    expect(block).toMatch(/if [^\n]*status-publish-run\.sh/)
    expect(block).toContain('status-publish-failed')
    expect(block).not.toMatch(/\bexit\b/)
  })

  it('bash -n 通過', () => {
    expect(spawnSync('bash', ['-n', nightScript]).status).toBe(0)
  })
})

describe('ssh-config.example', () => {
  it('有 Host fju-status-publish（fjustatus、BatchMode）', () => {
    const cfg = fs.readFileSync(path.join(repoRoot, 'ops/ssh-config.example'), 'utf8')
    const m = cfg.match(/^Host fju-status-publish\n((?: {2}.*\n|\s*#.*\n)*)/m)
    expect(m).not.toBeNull()
    expect(m![1]).toMatch(/User fjustatus/)
    expect(m![1]).toMatch(/BatchMode yes/)
  })
})
