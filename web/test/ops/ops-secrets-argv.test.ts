import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * CL-7（#823 第 4 條）：ops 腳本的機密只能經 stdin、環境變數或 `-K -` 傳入，不出現在指令列。
 * 從 `ops-guards.test.ts` 拆出來的新檔（CL-10 單檔 5,000 tokens 上限，舊檔已超過，不再加大）。
 * 全部在本機跑：FJU_ROOT 指到暫存目錄、外部指令換成假的，不 ssh、不讀真的 Doppler。
 */

const repoRoot = path.join(import.meta.dirname, '..', '..', '..')
const ops = (name: string) => path.join(repoRoot, 'ops', name)
const me = os.userInfo().username

let dir: string
let fjuRoot: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fju-ops-secrets-'))
  fjuRoot = path.join(dir, 'srv-fju')
  fs.mkdirSync(fjuRoot)
  fs.mkdirSync(path.join(dir, 'bin'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
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
    return argv.filter((line) => line.includes(LEAK)).map((line) => `${line.match(/cl7b-leak-([A-Z0-9_]+)/)![1]} ← ${line}`)
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
