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
  ['seed-demo.sh', ['test']],
  ['seed-demo.sh', ['test', '--remove']],
  ['auto-deploy.sh', []],
  ['site.sh', ['test', 'check']],
  ['fault-drill.sh', ['--site', 'test', 'restart', '--execute']],
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
    for (const script of ['backup.sh', 'restore-drill.sh', 'seed-admin.sh', 'seed-demo.sh', 'deploy.sh', 'fault-drill.sh']) {
      const r = run(script, ['--help'])
      expect(r.code, script).toBe(0)
    }
  })
})

describe('seed-demo.sh（票 32）：只准測試站', () => {
  it.each([['prod'], ['prod', '--remove'], ['staging']])('%s %s：就算是 deploy 身分，也在動任何東西之前拒絕', (...args) => {
    const r = run('seed-demo.sh', args.filter(Boolean), { user: me })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('一律拒絕')
    expect(r.calls).toEqual([])
    expect(r.written).toEqual([])
  })
})

describe('fault-drill.sh（票 28）：只准測試站、預設只印步驟', () => {
  it('--site prod：就算是 deploy 身分、帶了 --execute，也在動任何東西之前拒絕', () => {
    for (const drill of ['restart', 'worker-stall', 'poison']) {
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

  it.each(['restart', 'worker-stall', 'poison'])(
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

describe('cloudflare-origin-lock.sh（⑤-04）：只讓 Cloudflare 連進來', () => {
  const lock = ops('cloudflare-origin-lock.sh')
  const CHAIN = 'FJU-CF-ORIGIN'
  const READONLY = /^(iptables|ip6tables) (-V|-S)/

  function runLock(args: string[], fakeRoot: boolean) {
    const bin = path.join(dir, 'bin')
    const log = path.join(dir, 'fw.log')
    fs.writeFileSync(log, '')
    const fakes: Record<string, string> = {
      iptables: '[ "$1" = -V ] && echo "iptables v1.8.10 (nf_tables)"',
      ip6tables: '',
      systemctl: '',
      id: fakeRoot ? 'echo 0' : 'echo 1000',
    }
    for (const [name, body] of Object.entries(fakes)) {
      const f = path.join(bin, name)
      fs.writeFileSync(f, `#!/usr/bin/env bash\n${name === 'id' ? '' : `echo "${name} $*" >> "$FW_LOG"`}\n${body}\nexit 0\n`)
      fs.chmodSync(f, 0o755)
    }
    const unitDir = path.join(dir, 'units')
    const r = spawnSync('bash', [lock, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        FW_LOG: log,
        FJU_CF_IFACE: 'eth0',
        FJU_CF_UNIT_DIR: unitDir,
      },
      encoding: 'utf8',
      timeout: 20_000,
    })
    return {
      code: r.status,
      stdout: r.stdout,
      stderr: r.stderr,
      calls: fs.readFileSync(log, 'utf8').split('\n').filter(Boolean),
      unitDir,
    }
  }

  // 防火牆指令（iptables／ip6tables／systemctl）的序列，不含偵測用的唯讀呼叫。
  const sequence = (lines: string[]) =>
    lines
      .map((l) => l.replace(/^\s*\+ /, ''))
      .filter((l) => /^(iptables|ip6tables|systemctl) /.test(l))
      .filter((l) => !READONLY.test(l))

  it('不是 root、不帶 --execute：只印偵測結果與完整指令序列，沒有呼叫任何改規則的命令、沒寫單元', () => {
    const r = runLock([], false)
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('偵測結果')
    expect(r.stdout).toContain('iptables v1.8.10 (nf_tables)')
    expect(r.stdout).toContain('這是預覽，什麼都沒有執行')
    const printed = sequence(r.stdout.split('\n'))
    expect(printed).toContain(`iptables -I DOCKER-USER 1 -j ${CHAIN}`)
    expect(printed).toContain(`ip6tables -I DOCKER-USER 1 -j ${CHAIN}`)
    expect(printed).toContain('systemctl enable fju-cf-origin-lock.service')
    // 只有唯讀的偵測呼叫（-V、-S）；沒有任何一次真的改規則或碰 systemctl。
    expect(r.calls.filter((c) => !READONLY.test(c))).toEqual([])
    expect(fs.existsSync(r.unitDir)).toBe(false)
    // 非 root 帶 --execute 也只印。
    const x = runLock(['--execute'], false)
    expect(x.code).toBe(0)
    expect(x.stdout).toContain('不是 root：只印不做')
    expect(x.calls.filter((c) => !READONLY.test(c))).toEqual([])
    expect(fs.existsSync(x.unitDir)).toBe(false)
  })

  it('--execute（假 root、假 iptables／ip6tables／systemctl）：清鏈 → 建鏈 → 加規則 → jump → 寫單元 → enable', () => {
    const r = runLock(['--execute'], true)
    expect(r.code).toBe(0)
    const done = sequence(r.calls)
    for (const ipt of ['iptables', 'ip6tables']) {
      const mine = done.filter((l) => l.startsWith(`${ipt} `))
      const idx = (re: RegExp) => mine.findIndex((l) => re.test(l))
      const flush = idx(new RegExp(`-F ${CHAIN}$`))
      const create = idx(new RegExp(`-N ${CHAIN}$`))
      const firstRule = idx(new RegExp(`-A ${CHAIN} `))
      const drop = idx(new RegExp(`-A ${CHAIN} -j DROP$`))
      const jump = idx(new RegExp(`-I DOCKER-USER 1 -j ${CHAIN}$`))
      expect(flush, ipt).toBeGreaterThanOrEqual(0)
      expect(create, ipt).toBeGreaterThan(flush)
      expect(firstRule, ipt).toBeGreaterThan(create)
      expect(drop, ipt).toBeGreaterThan(firstRule)
      expect(jump, ipt).toBe(mine.length - 1)
      // 只套外網介面、80／443、新連線；Cloudflare 範圍放行。
      expect(mine).toContain(`${ipt} -A ${CHAIN} ! -i eth0 -j RETURN`)
      expect(mine).toContain(`${ipt} -A ${CHAIN} -p tcp -m multiport ! --dports 80,443 -j RETURN`)
      expect(mine).toContain(`${ipt} -A ${CHAIN} -m conntrack ! --ctstate NEW -j RETURN`)
    }
    expect(done).toContain(`iptables -A ${CHAIN} -s 173.245.48.0/20 -j RETURN`)
    expect(done).toContain(`ip6tables -A ${CHAIN} -s 2400:cb00::/32 -j RETURN`)
    // 規則全部做完才寫單元、enable。
    const unitFile = path.join(r.unitDir, 'fju-cf-origin-lock.service')
    expect(fs.existsSync(unitFile)).toBe(true)
    const unitText = fs.readFileSync(unitFile, 'utf8')
    expect(unitText).toContain('After=docker.service')
    expect(unitText).toMatch(/ExecStart=.*cloudflare-origin-lock\.sh --execute/)
    expect(done.slice(-2)).toEqual(['systemctl daemon-reload', 'systemctl enable fju-cf-origin-lock.service'])
    const lastFw = Math.max(...done.map((l, i) => (/^ip6?tables /.test(l) ? i : -1)))
    expect(lastFw).toBeLessThan(done.length - 2)
  })

  it('Caddyfile.vm 的 trusted_proxies 與腳本的 Cloudflare 範圍是同一份', () => {
    const script = fs.readFileSync(lock, 'utf8')
    const lists = [...script.matchAll(/^CF_V[46]=\(([^)]*)\)/gm)].map((m) => m[1]).join(' ')
    const fromScript = [...lists.matchAll(/\b[0-9a-f:.]+\/\d+\b/g)].map((m) => m[0]).sort()
    const caddy = fs.readFileSync(ops('Caddyfile.vm'), 'utf8')
    const line = caddy.split('\n').find((l) => l.includes('trusted_proxies static'))!
    const fromCaddy = line.replace(/^.*static\s+/, '').trim().split(/\s+/).sort()
    expect(fromCaddy.length).toBeGreaterThan(10)
    expect(fromScript).toEqual(fromCaddy)
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
    ['seed-demo.sh', ['--help'], undefined],
    ['seed-demo.sh', ['prod'], 'self'],
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
