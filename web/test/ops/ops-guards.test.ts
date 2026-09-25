import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * ops 腳本的兩個小護欄（PR #262 審查後續）：
 *
 * 1. 身分守門：會寫 /srv/fju 的腳本不是 deploy 身分就在動任何東西之前停下，提示 `sudo -u deploy …`。
 * 2. 中文語系：zh_TW.UTF-8 下 `$VAR` 緊貼中文字會被 bash 當成變數名的一部分（unbound variable），
 *    所以腳本裡一律寫成 `${VAR}`。
 *
 * 全部在本機跑：FJU_ROOT 指到暫存目錄、docker 換成只記錄呼叫的假指令，不 ssh、不讀 Doppler。
 */

const repoRoot = path.join(import.meta.dirname, '..', '..', '..')
const ops = (name: string) => path.join(repoRoot, 'ops', name)
const me = os.userInfo().username
const NOT_ME = `not-${me}`

let dir: string
let fjuRoot: string
let callsLog: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fju-ops-guard-'))
  fjuRoot = path.join(dir, 'srv-fju')
  fs.mkdirSync(fjuRoot)
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  callsLog = path.join(dir, 'calls.log')
  fs.writeFileSync(callsLog, '')
  // docker、doppler、flock 一被呼叫就記下來並失敗：守門應該在它們之前就停。
  for (const name of ['docker', 'doppler', 'flock']) {
    const fake = path.join(bin, name)
    fs.writeFileSync(fake, `#!/usr/bin/env bash\necho "${name} $*" >> "$CALLS_LOG"\nexit 99\n`)
    fs.chmodSync(fake, 0o755)
  }
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function run(
  script: string,
  args: string[],
  opts: { user?: string; locale?: string; bash?: string } = {},
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${path.join(dir, 'bin')}:${process.env.PATH ?? ''}`,
    FJU_ROOT: fjuRoot,
    FJU_SECRETS_DIR: path.join(fjuRoot, 'secrets'),
    FJU_DEPLOY_USER: opts.user ?? NOT_ME,
    CALLS_LOG: callsLog,
  }
  delete env.FJU_SECRETS_LOADED
  delete env.DEPLOY_DIR
  if (opts.locale) {
    env.LC_ALL = opts.locale
    env.LANG = opts.locale
  }
  const r = spawnSync(opts.bash ?? 'bash', [ops(script), ...args], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: 20_000,
  })
  return {
    code: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    calls: fs.readFileSync(callsLog, 'utf8').split('\n').filter(Boolean),
    written: fs.readdirSync(fjuRoot, { recursive: true }),
  }
}

/** 每支會寫 /srv/fju 的腳本，配一組「參數都對、只差身分」的呼叫。 */
const GUARDED: Array<[string, string[]]> = [
  ['backup.sh', ['--site', 'test']],
  ['backup.sh', ['--site', 'test', '--status']],
  ['restore-drill.sh', ['--site', 'test', '--backup', 'latest']],
  ['restore-drill.sh', ['--remove']],
  ['deploy.sh', ['--site', 'test', 'abc123', '--execute']],
  ['seed-admin.sh', ['test']],
  ['auto-deploy.sh', []],
  ['site.sh', ['test', 'check']],
  ['fault-drill.sh', ['--site', 'test', 'restart', '--execute']],
  ['fault-drill.sh', ['--site', 'test', 'disk80', '--execute']],
]

describe('身分守門：不是 deploy 就什麼都不做', () => {
  it.each(GUARDED)('%s %s → 非 0 結束、提示 sudo -u，且沒寫任何檔、沒呼叫 docker', (script, args) => {
    const r = run(script, args)
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain(`身分執行（現在是 ${me}）`)
    expect(r.stderr).toContain(`sudo -u ${NOT_ME} `)
    expect(r.written).toEqual([])
    expect(r.calls).toEqual([])
  })

  it('deploy.sh 的演練（dry-run）不寫任何東西，任何人都能跑', () => {
    const r = run('deploy.sh', ['--site', 'test', 'abc123'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('這是演練，什麼都沒有執行')
    expect(r.written).toEqual([])
  })

  it('--help 不需要 deploy 身分', () => {
    for (const script of ['backup.sh', 'restore-drill.sh', 'seed-admin.sh', 'deploy.sh', 'fault-drill.sh']) {
      const r = run(script, ['--help'])
      expect(r.code, script).toBe(0)
    }
  })
})

describe('fault-drill.sh（票 28）：只准測試站、預設只印步驟', () => {
  it('--site prod：就算是 deploy 身分、帶了 --execute，也在動任何東西之前拒絕', () => {
    for (const drill of ['restart', 'worker-stall', 'poison', 'disk80', 'disk80-restore']) {
      const r = run('fault-drill.sh', ['--site', 'prod', drill, '--execute'], { user: me })
      expect(r.code, drill).not.toBe(0)
      expect(r.stderr).toContain('只准對測試站')
      expect(r.calls).toEqual([])
      expect(r.written).toEqual([])
    }
  })

  it('沒給站台、給了別的站台、不認得的演練：都拒絕', () => {
    expect(run('fault-drill.sh', ['restart'], { user: me }).stderr).toContain('缺少 --site')
    expect(run('fault-drill.sh', ['--site', 'staging', 'restart'], { user: me }).stderr).toContain('站台只能是 test')
    expect(run('fault-drill.sh', ['--site', 'test', 'fill-disk'], { user: me }).stderr).toContain('不認得的演練')
    expect(run('fault-drill.sh', ['--site', 'test'], { user: me }).stderr).toContain('缺少要跑的演練')
  })

  it.each(['restart', 'worker-stall', 'poison', 'disk80', 'disk80-restore'])(
    '%s 不帶 --execute：任何人都能跑，只印步驟，不呼叫 docker、不寫檔',
    (drill) => {
      const r = run('fault-drill.sh', ['--site', 'test', drill])
      expect(r.code).toBe(0)
      expect(r.stdout).toContain('這是演練，什麼都沒有執行')
      expect(r.stdout).toContain('Compose project fju-test')
      expect(r.calls).toEqual([])
      expect(r.written).toEqual([])
    },
  )

  it('disk80 只在記憶體磁碟上塞檔案，不碰真的附件目錄', () => {
    const r = run('fault-drill.sh', ['--site', 'test', 'disk80'])
    expect(r.stdout).toContain('--opt type=tmpfs')
    expect(r.stdout).toContain('--path /drill-disk --drill')
  })
})

describe('restore-drill.sh 的參數與目錄檢查', () => {
  it('--with-app 沒帶 --keep 直接拒絕（不起副本、不寫紀錄）', () => {
    const r = run('restore-drill.sh', ['--site', 'test', '--backup', 'latest', '--with-app'], { user: me })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('--with-app 要搭配 --keep')
    expect(r.calls).toEqual([])
    expect(r.written).toEqual([])
  })

  it('該站 backups/ 不存在時說「還沒備份過」，不是 find 的錯', () => {
    const r = run('restore-drill.sh', ['--site', 'test', '--backup', 'latest'], { user: me })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('還沒有備份目錄')
    expect(r.stderr).toContain('ops/backup.sh --site test')
    expect(r.stderr).not.toContain('No such file')
    expect(r.calls).toEqual([])
    expect(r.written).toEqual([])
  })

  it('backup.sh --status 在還沒備份過時也好好說明', () => {
    const r = run('backup.sh', ['--site', 'test', '--status'], { user: me })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('還沒有備份目錄')
    expect(r.written).toEqual([])
  })
})

describe('中文語系：$VAR 後面緊貼中文字', () => {
  const scripts = [
    ...fs.readdirSync(path.join(repoRoot, 'ops')).filter((f) => f.endsWith('.sh')),
    ...fs.readdirSync(path.join(repoRoot, 'ops/lib')).filter((f) => f.endsWith('.sh')).map((f) => `lib/${f}`),
  ]

  it('ops/*.sh、ops/lib/*.sh 沒有任何 `$變數` 緊接非 ASCII 字元（要寫成 ${變數}）', () => {
    const hits: string[] = []
    for (const f of scripts) {
      fs.readFileSync(ops(f), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const m of line.matchAll(/\$[A-Za-z_][A-Za-z0-9_]*(?=[\u0080-\u{10FFFF}])/gu)) {
            hits.push(`ops/${f}:${i + 1}: ${m[0]}`)
          }
        })
    }
    expect(hits).toEqual([])
  })

  // 系統有 zh_TW.UTF-8（macOS 有）才真的重現得出來；沒有時 bash 退回 C 語系，這些照樣要過。
  const shells = ['bash', ...(fs.existsSync('/bin/bash') ? ['/bin/bash'] : [])]
  const locale = 'zh_TW.UTF-8'
  const paths: Array<[string, string[], string | undefined]> = [
    ['deploy.sh', ['--site', 'test', 'abc123'], undefined],
    ['deploy.sh', ['--site', 'prod', 'abc123', '--rollback'], undefined],
    ['deploy.sh', ['--site', 'test', 'abc123', 'def456'], undefined],
    ['backup.sh', ['--help'], undefined],
    ['restore-drill.sh', ['--help'], undefined],
    ['seed-admin.sh', ['--help'], undefined],
    ['backup.sh', ['--site', 'test'], undefined],
    ['restore-drill.sh', ['--site', 'test', '--backup', 'latest'], 'self'],
    ['backup.sh', ['--site', 'test', '--status'], 'self'],
    ['auto-deploy.sh', [], undefined],
  ]

  for (const shell of shells) {
    it.each(paths)(`${shell}：LC_ALL=${locale} %s %s 不會 unbound variable`, (script, args, user) => {
      const r = run(script, args, { locale, bash: shell, user: user === 'self' ? me : undefined })
      expect(r.stderr).not.toMatch(/unbound variable/)
      expect(r.calls).toEqual([])
    })
  }
})
