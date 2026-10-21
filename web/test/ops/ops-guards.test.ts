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
  opts: { user?: string; locale?: string; bash?: string; env?: Record<string, string> } = {},
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...opts.env,
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
  ['backup-daily.sh', []],
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
  it('⑤-18：docker compose run 以名稱轉交 SEED_DEMO_PASSWORD（不帶值，值不進指令列）', () => {
    const script = fs.readFileSync(ops('seed-demo.sh'), 'utf8')
    const run = script.split('\n').find((line) => line.startsWith('docker compose run'))!
    expect(run).toMatch(/ -e SEED_DEMO_PASSWORD /)
    expect(script).not.toMatch(/SEED_DEMO_PASSWORD=/)
  })

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

describe('Healthchecks.io 打卡（⑤-06）：有 url 檔才呼叫 curl', () => {
  // 假網址；測試與 repo 都不放真網址。
  const FAKE_URL = 'https://hc.example/ping/fake'
  const secrets = () => path.join(fjuRoot, 'secrets')
  const curlCalls = (calls: string[]) => calls.filter((c) => c.startsWith('curl '))
  /** 假 curl 收到的 stdin（curl 設定檔 `-K -`）：網址只能從這裡進去，不能出現在指令列。 */
  const curlStdin = () => {
    const file = path.join(dir, 'curl-stdin.log')
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
  }
  /** 斷言：每次 curl 的參數都沒有網址，stdin 依序是這些網址。 */
  function expectUrlsOnStdinOnly(calls: string[], urls: string[]) {
    for (const c of curlCalls(calls)) {
      expect(c).not.toContain('hc.example')
      expect(c).toContain('-K -')
    }
    expect(curlStdin()).toEqual(urls.map((u) => `url = "${u}"`))
  }

  function fakeCommand(name: string, body: string) {
    const file = path.join(dir, 'bin', name)
    fs.writeFileSync(file, `#!/usr/bin/env bash\necho "${name} $*" >> "$CALLS_LOG"\n${body}\n`)
    fs.chmodSync(file, 0o755)
  }

  function writeUrlFile(name: string) {
    fs.mkdirSync(secrets(), { recursive: true })
    fs.writeFileSync(path.join(secrets(), name), `${FAKE_URL}\n`, { mode: 0o600 })
  }

  beforeEach(() => {
    fakeCommand('curl', `cat >> "${path.join(dir, 'curl-stdin.log')}"; exit 0`)
  })

  /** auto-deploy 走到「拿鎖」那一步：token 檔在、手動部署過一次。假 flock 失敗＝上一輪還在跑（exit 0）。 */
  function prepareAutoDeploy() {
    fs.mkdirSync(secrets(), { recursive: true })
    fs.writeFileSync(path.join(secrets(), 'doppler-test.token'), 'not-a-real-token', { mode: 0o600 })
    const deployDir = path.join(fjuRoot, 'test', 'deploy')
    fs.mkdirSync(deployDir, { recursive: true })
    fs.writeFileSync(path.join(deployDir, 'deploy_log'), `2026-10-21T00:00:00Z\tdeployed\t${'0'.repeat(40)}\tfull\n`)
  }

  it('auto-deploy：有 url 檔 → 檢查完畢（exit 0）呼叫假 curl 一次，打成功網址、body 是這輪的說明', () => {
    prepareAutoDeploy()
    writeUrlFile('healthchecks-deploy.url')
    const r = run('auto-deploy.sh', [], { user: me })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('上一輪還在跑')
    const curls = curlCalls(r.calls)
    expect(curls).toHaveLength(1)
    expect(curls[0]).toContain('-fsS -m 10 --retry 3 -o /dev/null')
    expect(curls[0]).toContain('--data-raw 上一輪還在跑')
    expectUrlsOnStdinOnly(r.calls, [FAKE_URL])
    expect(r.stdout).toContain('[healthchecks] ping 已送（成功）')
    expect(r.stdout).not.toContain('hc.example')
  })

  it('auto-deploy：沒有 url 檔 → 行為不變、不呼叫 curl（AC-35）', () => {
    prepareAutoDeploy()
    const r = run('auto-deploy.sh', [], { user: me })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('上一輪還在跑')
    expect(curlCalls(r.calls)).toEqual([])
    expect(r.stdout).not.toContain('[healthchecks]')
  })

  it('auto-deploy：這輪失敗（拉不到映像，exit 1）→ 打 /fail，exit code 不變', () => {
    prepareAutoDeploy()
    writeUrlFile('healthchecks-deploy.url')
    fakeCommand('flock', 'exit 0')
    const r = run('auto-deploy.sh', [], { user: me })
    expect(r.code).toBe(1)
    const curls = curlCalls(r.calls)
    expect(curls).toHaveLength(1)
    expect(curls[0]).toContain('--data-raw exit 1：拉不到')
    expectUrlsOnStdinOnly(r.calls, [`${FAKE_URL}/fail`])
  })

  it('auto-deploy：curl 失敗只印一行，不改這輪的 exit code', () => {
    prepareAutoDeploy()
    writeUrlFile('healthchecks-deploy.url')
    fakeCommand('curl', `cat >> "${path.join(dir, 'curl-stdin.log')}"; exit 7`)
    const r = run('auto-deploy.sh', [], { user: me })
    expect(r.code).toBe(0)
    expect(curlCalls(r.calls)).toHaveLength(1)
    expect(r.stdout).toContain('ping 沒送出')
  })

  it('backup-daily：沒有正式站容器 → 印「正式站不存在，略過」、送 /start 與成功、exit 0（AC-38）', () => {
    writeUrlFile('healthchecks-backup.url')
    const r = run('backup-daily.sh', [], { user: me, env: { BACKUP_DISK_USED_PCT: '42' } })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('正式站不存在，略過')
    expect(r.calls).toContain('docker inspect fju-prod-postgres')
    const curls = curlCalls(r.calls)
    expect(curls).toHaveLength(2)
    expect(curls[1]).toContain('磁碟 42%')
    expectUrlsOnStdinOnly(r.calls, [`${FAKE_URL}/start`, FAKE_URL])
    // 正式站不存在就不跑 backup.sh、不建異地目錄。
    expect(r.written).toEqual(['secrets', path.join('secrets', 'healthchecks-backup.url')])
  })

  it('backup-daily：磁碟 ≥ 80% → 送 /fail，body 含「磁碟 NN%」（AC-39）', () => {
    writeUrlFile('healthchecks-backup.url')
    const r = run('backup-daily.sh', [], { user: me, env: { BACKUP_DISK_USED_PCT: '85' } })
    expect(r.code).toBe(0)
    const curls = curlCalls(r.calls)
    expect(curls).toHaveLength(2)
    expect(curls[1]).toContain('--data-raw 磁碟 85%')
    expectUrlsOnStdinOnly(r.calls, [`${FAKE_URL}/start`, `${FAKE_URL}/fail`])
  })

  it('backup-daily：正式站在但 backup.sh 失敗（這裡是取不到 Doppler 秘密）→ 送 /fail、非 0 結束、不同步異地', () => {
    writeUrlFile('healthchecks-backup.url')
    fakeCommand('docker', 'exit 0')
    const r = run('backup-daily.sh', [], { user: me, env: { BACKUP_DISK_USED_PCT: '42' } })
    expect(r.code).not.toBe(0)
    expect(r.stdout).toContain('正式站備份失敗')
    const curls = curlCalls(r.calls)
    expect(curls).toHaveLength(2)
    expect(curls[1]).toContain('--data-raw 正式站備份失敗')
    expectUrlsOnStdinOnly(r.calls, [`${FAKE_URL}/start`, `${FAKE_URL}/fail`])
    expect(fs.existsSync(path.join(fjuRoot, 'offsite'))).toBe(false)
  })

  it('hc_ping：網址含 " 或 \\ 時照 curl 設定檔規則跳脫，指令列仍不出現網址', () => {
    const file = path.join(dir, 'odd.url')
    fs.writeFileSync(file, 'https://hc.example/ping/a"b\\c\n')
    const r = spawnSync('bash', ['-c', `. "${ops('lib/healthchecks.sh')}"; hc_ping "$1" fail`, '_', file], {
      env: { ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH ?? ''}`, CALLS_LOG: callsLog },
      encoding: 'utf8',
    })
    expect(r.status).toBe(0)
    const calls = fs.readFileSync(callsLog, 'utf8').split('\n').filter(Boolean)
    expect(curlCalls(calls)).toHaveLength(1)
    expect(curlCalls(calls)[0]).not.toContain('hc.example')
    expect(curlStdin()).toEqual(['url = "https://hc.example/ping/a\\"b\\\\c/fail"'])
  })

  it('backup-daily：沒有 url 檔 → 照樣跑完、不呼叫 curl', () => {
    const r = run('backup-daily.sh', [], { user: me, env: { BACKUP_DISK_USED_PCT: '85' } })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('正式站不存在，略過')
    expect(r.stdout).toContain('磁碟 85%')
    expect(curlCalls(r.calls)).toEqual([])
  })
})

describe('cloudflare-origin-lock.sh（⑤-04）：只讓 Cloudflare 連進來', () => {
  const lock = ops('cloudflare-origin-lock.sh')
  const CHAIN = 'FJU-CF-ORIGIN'
  const READONLY = /^(iptables|ip6tables) (-V|-S)/

  function runLock(args: string[], fakeRoot: boolean, opts: { brokenIp?: boolean; iface?: string } = {}) {
    const bin = path.join(dir, 'bin')
    const log = path.join(dir, 'fw.log')
    fs.writeFileSync(log, '')
    const fakes: Record<string, string> = {
      iptables: '[ "$1" = -V ] && echo "iptables v1.8.10 (nf_tables)"',
      ip6tables: '',
      systemctl: '',
      id: fakeRoot ? 'echo 0' : 'echo 1000',
      ...(opts.brokenIp ? { ip: 'exit 127' } : {}),
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
        FJU_CF_UNIT_DIR: unitDir,
        ...(opts.iface === undefined ? { FJU_CF_IFACE: 'eth0' } : opts.iface ? { FJU_CF_IFACE: opts.iface } : {}),
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

  it('沒有可用的 ip 指令（例如 Mac）：dry-run 仍 exit 0 並印完整序列；--execute 沒有介面就報錯退出、不碰 iptables', () => {
    const d = runLock([], false, { brokenIp: true })
    expect(d.code).toBe(0)
    expect(d.stdout).toContain('這是預覽，什麼都沒有執行')
    const printed = sequence(d.stdout.split('\n'))
    expect(printed).toContain(`iptables -I DOCKER-USER 1 -j ${CHAIN}`)
    expect(printed).toContain(`ip6tables -I DOCKER-USER 1 -j ${CHAIN}`)
    expect(printed).toContain('systemctl enable fju-cf-origin-lock.service')
    // 沒指定介面時也一樣印得完（介面顯示佔位字）。
    const d2 = runLock([], false, { brokenIp: true, iface: '' })
    expect(d2.code).toBe(0)
    expect(sequence(d2.stdout.split('\n'))).toContain(`iptables -I DOCKER-USER 1 -j ${CHAIN}`)
    const x = runLock(['--execute'], true, { brokenIp: true, iface: '' })
    expect(x.code).not.toBe(0)
    expect(x.stderr).toContain('找不到外網介面')
    expect(sequence(x.calls)).toEqual([])
    expect(fs.existsSync(x.unitDir)).toBe(false)
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
  // repo 根目錄起算的相對路徑；教學影片工具的 env 腳本也在 zh_TW 終端機跑，一起掃（#410）。
  const shellsIn = (d: string) =>
    fs.readdirSync(path.join(repoRoot, d)).filter((f) => f.endsWith('.sh')).map((f) => `${d}/${f}`)
  const scripts = [...shellsIn('ops'), ...shellsIn('ops/lib'), ...shellsIn('tools/tutorial/env')]

  it('ops/*.sh、ops/lib/*.sh、tools/tutorial/env/*.sh 沒有任何 `$變數` 緊接非 ASCII 字元（要寫成 ${變數}）', () => {
    expect(scripts).toContain('tools/tutorial/env/lib.sh')
    const hits: string[] = []
    for (const f of scripts) {
      fs.readFileSync(path.join(repoRoot, f), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const m of line.matchAll(/\$[A-Za-z_][A-Za-z0-9_]*(?=[\u0080-\u{10FFFF}])/gu)) {
            hits.push(`${f}:${i + 1}: ${m[0]}`)
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
    ['backup-daily.sh', [], undefined],
  ]

  for (const shell of shells) {
    it.each(paths)(`${shell}：LC_ALL=${locale} %s %s 不會 unbound variable`, (script, args, user) => {
      const r = run(script, args, { locale, bash: shell, user: user === 'self' ? me : undefined })
      expect(r.stderr).not.toMatch(/unbound variable/)
      expect(r.calls).toEqual([])
    })
  }
})

describe('機密不出現在指令列（CL-7 #823 第 4 條）：只能經 stdin、環境變數或 `-K -` 傳入', () => {
  /**
   * 實跑 ops 腳本：doppler、docker、curl、psql、ssh、flock 換成「把整串參數記下來」的假指令，
   * 假 doppler 照真的行為把機密放進環境再執行 `--` 後面的指令，所以腳本會一路跑進 docker compose 那幾步。
   * 每個機密的值都帶 `cl7b-leak-<鍵名>`；任何一筆參數出現這個字樣就紅，訊息帶鍵名與那一筆呼叫。
   * 另外斷言機密真的有送到（token 在 DOPPLER_TOKEN、密碼在 stdin、`-e 名稱` 轉交的鍵有值），免得空跑也綠。
   */
  const LEAK = 'cl7b-leak-'
  const TOKEN = `${LEAK}DOPPLER_TOKEN`
  const HC_URL = `https://hc.example/ping/${LEAK}HC_URL`
  const SECRET_KEYS = [
    'POSTGRES_PASSWORD',
    'DATABASE_URL',
    'DATABASE_URL_OWNER',
    'APP_DB_PASSWORD',
    'BETTER_AUTH_SECRET',
    'GOOGLE_CLIENT_SECRET',
    'A1_INITIAL_PASSWORD',
    'E2E_ADMIN_PASSWORD',
    'SEED_DEMO_PASSWORD',
  ]
  /** 假 Doppler 注入的值：機密帶記號，其餘是腳本需要的一般設定。 */
  const DOPPLER_ENV: Record<string, string> = {
    DOPPLER_CONFIG: 'stg',
    DOPPLER_PROJECT: 'fju-im-capstone',
    POSTGRES_USER: 'fake_owner',
    POSTGRES_DB: 'fju',
    BETTER_AUTH_URL: 'https://test.fju.roy422.dev',
    GOOGLE_CLIENT_ID: 'fake-client-id',
    FILES_ROOT: '/srv/fju/files',
    FILE_MAX_BYTES: '104857600',
    BUSINESS_CLOCK_OVERRIDE_ENABLED: 'true',
    A1_EMAIL: 'a1@example.test',
    E2E_ADMIN_EMAIL: 'e2e@example.test',
    ...Object.fromEntries(SECRET_KEYS.map((k) => [k, `${LEAK}${k}`])),
  }

  let argvLog: string
  let stdinLog: string
  let envLog: string

  /** 每次呼叫記成一行：指令名與每個參數用 TAB 隔開（參數裡的換行換成 \n 字樣）。 */
  const LOGGER = `log_argv() { local a line="$1"; shift; for a in "$@"; do line+=$'\\t'"\${a//$'\\n'/\\\\n}"; done; printf '%s\\n' "$line" >> "$ARGV_LOG"; }`

  function fake(name: string, body: string) {
    const file = path.join(dir, 'bin', name)
    fs.writeFileSync(file, `#!/usr/bin/env bash\n${LOGGER}\nlog_argv ${name} "$@"\n${body}\n`)
    fs.chmodSync(file, 0o755)
  }

  beforeEach(() => {
    argvLog = path.join(dir, 'argv.log')
    stdinLog = path.join(dir, 'stdin.log')
    envLog = path.join(dir, 'env.log')
    for (const f of [argvLog, stdinLog, envLog]) fs.writeFileSync(f, '')
    const secretsFile = path.join(dir, 'doppler.env')
    fs.writeFileSync(secretsFile, Object.entries(DOPPLER_ENV).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')
    const watched = SECRET_KEYS.concat('A1_EMAIL', 'E2E_ADMIN_EMAIL', 'FJU_SITE', 'FILES_ROOT').join(' ')
    // doppler run --no-fallback -- <指令…>：核對 token 從環境來，注入機密後執行 -- 後面的指令（跟真的一樣 exec）。
    fake(
      'doppler',
      [
        `printf 'DOPPLER_TOKEN=%s\\n' "$([ "\${DOPPLER_TOKEN:-}" = '${TOKEN}' ] && echo ok || echo missing)" >> "$ENV_LOG"`,
        `set -a; . '${secretsFile}'; set +a`,
        'while [ $# -gt 0 ] && [ "$1" != -- ]; do shift; done; shift',
        'exec "$@"',
      ].join('\n'),
    )
    fake(
      'docker',
      [
        'case "$1 ${2:-}" in',
        "  'inspect '*) echo ghcr.io/roy4222/fju-web:old ;;",
        "  'image inspect') echo ghcr.io/roy4222/fju-web@sha256:0000 ;;",
        "  'compose ps') echo ghcr.io/roy4222/fju-web:old ;;",
        `  'compose exec') printf 'docker compose exec stdin: ' >> "$STDIN_LOG"; cat >> "$STDIN_LOG" ;;`,
        `  'compose run')`,
        // 轉交進容器的鍵只記「有沒有值」，不記值本身。
        `    for k in ${watched}; do [ -n "\${!k:-}" ] && printf 'run %s=set\\n' "$k" >> "$ENV_LOG"; done`,
        '    echo SCHEMA_VERSION=1 ;;',
        'esac',
        'exit 0',
      ].join('\n'),
    )
    // 健康檢查一律失敗（讓部署很快走到回滾）；`-K -` 的設定檔從 stdin 收下來。
    fake('curl', `case " $* " in *' -K - '*) printf 'curl stdin: ' >> "$STDIN_LOG"; cat >> "$STDIN_LOG" ;; esac\nexit 22`)
    fake('psql', 'exit 0')
    fake('ssh', 'exit 0')
    fake('flock', 'exit 0')
    fs.mkdirSync(path.join(fjuRoot, 'secrets'), { recursive: true })
    fs.writeFileSync(path.join(fjuRoot, 'secrets', 'doppler-test.token'), `${TOKEN}\n`, { mode: 0o600 })
  })

  function runAsDeploy(script: string, args: string[], env: Record<string, string> = {}) {
    const r = spawnSync('bash', [ops(script), ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...env,
        PATH: `${path.join(dir, 'bin')}:${process.env.PATH ?? ''}`,
        FJU_ROOT: fjuRoot,
        FJU_SECRETS_DIR: path.join(fjuRoot, 'secrets'),
        FJU_DEPLOY_USER: me,
        ARGV_LOG: argvLog,
        STDIN_LOG: stdinLog,
        ENV_LOG: envLog,
        HEALTH_TIMEOUT_SECONDS: '1',
        CALLS_LOG: callsLog,
      },
      input: '',
      encoding: 'utf8',
      timeout: 30_000,
    })
    const lines = (f: string) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, argv: lines(argvLog), stdin: lines(stdinLog), env: lines(envLog) }
  }

  /** 每一筆參數都不准帶任何機密；回傳「鍵名 ← 那一筆呼叫」方便看是哪裡漏的。 */
  function leaks(argv: string[]) {
    return argv.filter((line) => line.includes(LEAK)).map((line) => `${line.match(/cl7b-leak-([A-Z_]+)/)![1]} ← ${line}`)
  }

  it('deploy.sh --execute（測試站）：token 走環境、fju_app 密碼走 stdin、E2E／示範帳號用 -e 名稱轉交，參數裡都沒有值', () => {
    const r = runAsDeploy('deploy.sh', ['--site', 'test', 'abc123', '--execute'])
    expect(leaks(r.argv)).toEqual([])
    // 真的跑到了：doppler 收到 token、psql 那一步的 SQL 從 stdin 帶著密碼、seed 時鍵有轉交進去。
    expect(r.argv.some((l) => l.startsWith('doppler\trun\t--no-fallback\t--'))).toBe(true)
    expect(r.env).toContain('DOPPLER_TOKEN=ok')
    expect(r.stdin.some((l) => l.startsWith('docker compose exec stdin: ') && l.includes(`${LEAK}APP_DB_PASSWORD`))).toBe(true)
    expect(r.argv.some((l) => l.includes('seed-e2e.mjs') && l.includes('-e\tE2E_ADMIN_PASSWORD'))).toBe(true)
    expect(r.argv.some((l) => l.includes('seed-demo.mjs') && l.includes('-e\tSEED_DEMO_PASSWORD'))).toBe(true)
    expect(r.env).toContain('run E2E_ADMIN_PASSWORD=set')
  })

  it('seed-admin.sh test：A1 密碼用 -e 名稱轉交，值不進參數', () => {
    const r = runAsDeploy('seed-admin.sh', ['test'])
    expect(r.code).toBe(0)
    expect(leaks(r.argv)).toEqual([])
    expect(r.env).toContain('DOPPLER_TOKEN=ok')
    expect(r.argv.some((l) => l.includes('seed-a1.mjs') && l.includes('-e\tA1_INITIAL_PASSWORD'))).toBe(true)
    expect(r.env).toContain('run A1_INITIAL_PASSWORD=set')
  })

  it('seed-demo.sh test：示範帳號密碼用 -e 名稱轉交，值不進參數', () => {
    const r = runAsDeploy('seed-demo.sh', ['test'])
    expect(r.code).toBe(0)
    expect(leaks(r.argv)).toEqual([])
    expect(r.env).toContain('DOPPLER_TOKEN=ok')
    expect(r.env).toContain('run SEED_DEMO_PASSWORD=set')
  })

  it('site.sh test check、backup.sh --site test：token 只走環境，參數裡沒有機密', () => {
    for (const [script, args] of [
      ['site.sh', ['test', 'check']],
      ['backup.sh', ['--site', 'test']],
    ] as const) {
      fs.writeFileSync(argvLog, '')
      fs.writeFileSync(envLog, '')
      const r = runAsDeploy(script, [...args])
      expect(leaks(r.argv), script).toEqual([])
      expect(r.env, script).toContain('DOPPLER_TOKEN=ok')
    }
  })

  it('Healthchecks 打卡（auto-deploy 失敗路徑）：網址只走 curl 的 `-K -` stdin', () => {
    fs.writeFileSync(path.join(fjuRoot, 'secrets', 'healthchecks-deploy.url'), `${HC_URL}\n`, { mode: 0o600 })
    const deployDir = path.join(fjuRoot, 'test', 'deploy')
    fs.mkdirSync(deployDir, { recursive: true })
    fs.writeFileSync(path.join(deployDir, 'deploy_log'), `2026-10-21T00:00:00Z\tdeployed\t${'0'.repeat(40)}\tfull\n`)
    const r = runAsDeploy('auto-deploy.sh', [])
    expect(leaks(r.argv)).toEqual([])
    expect(r.argv.some((l) => l.startsWith('curl\t') && l.includes('\t-K\t-'))).toBe(true)
    expect(r.stdin).toContainEqual(expect.stringContaining(`curl stdin: url = "${HC_URL}`))
  })
})
