import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const exec = promisify(execFile)
const repoRoot = path.join(import.meta.dirname, '..', '..', '..')
const deploySh = path.join(repoRoot, 'ops/deploy.sh')

/**
 * R4／R5：真的跑 `ops/deploy.sh --execute` 的失敗情境。
 *
 * 不碰 Docker daemon——把 `docker`、`flock`、`curl` 換成假的可執行檔放在 PATH 前面。
 * 假的 `docker` 會把每一次呼叫記到 calls.log，並依情境決定哪一步失敗；
 * 假的 `curl` 讀一個「目前世界長什麼樣」的 health 檔，而那個檔是假 `docker` 在
 * `up` 的時候依當下的 APP_IMAGE／IMAGE_DIGEST 寫出來的——換言之，跑起來的是哪個映像，
 * health 就回報哪個映像，跟真實情況一樣。
 */

const FAKE_DOCKER = `#!/usr/bin/env bash
set -u
printf '%s\\n' "$*" >> "$CALLS_LOG"

digest_of() { printf 'sha256:%s' "$(printf '%s' "$1" | cksum | tr -d ' ' | head -c 12)"; }

# 依目前的 APP_IMAGE 寫出 health 回應（跑起來的是哪個映像就回報哪個）。
write_health() {
  local image="\${APP_IMAGE:-}" commit
  commit="\${image##*:}"
  if [ "\${FORCE_BAD_HEALTH:-0}" = 1 ] && [ "$image" = "\${NEW_IMAGE:-}" ]; then
    commit="stale-commit"
  fi
  printf '{"ok":true,"version":"1","commit":"%s","imageDigest":"%s","schemaVersion":"%s","worker":{"version":null,"lastTickAt":null}}' \\
    "$commit" "\${IMAGE_DIGEST:-}" "\${FAKE_SCHEMA}" > "$HEALTH_FILE"
}

case "$1" in
  image)
    # docker image inspect --format ... <image>
    digest_of "\${@: -1}"
    ;;
  compose)
    shift
    case "$1" in
      ps)   printf '%s\\n' "\${PREV_IMAGE:-}" ;;
      pull) [ "\${FAIL_PULL:-0}" = 1 ] && exit 7; exit 0 ;;
      run)
        [ "\${FAIL_MIGRATE:-0}" = 1 ] && { echo "migrate 爆炸" >&2; exit 3; }
        echo "migration 完成；schema_meta.schema_version = \${FAKE_SCHEMA}"
        echo "SCHEMA_VERSION=\${FAKE_SCHEMA}"
        ;;
      up)
        if printf '%s ' "$@" | grep -q ' postgres'; then
          [ "\${FAIL_PG:-0}" = 1 ] && exit 9
          exit 0
        fi
        # app／worker
        if [ "\${FAIL_UP:-0}" = 1 ] && [ "\${APP_IMAGE:-}" = "\${NEW_IMAGE:-}" ]; then
          echo "worker 起不來" >&2
          exit 42
        fi
        write_health
        exit 0
        ;;
      exec)
        # fju_app 密碼同步：SQL 從 stdin 進來，存起來給測試檢查。
        cat > "$EXEC_STDIN"
        exit 0
        ;;
      *) exit 0 ;;
    esac
    ;;
  *) exit 0 ;;
esac
`

const FAKE_FLOCK = `#!/usr/bin/env bash
[ "\${FLOCK_BUSY:-0}" = 1 ] && exit 1
exit 0
`

/**
 * 已經在 Doppler 環境裡的樣子（ops/lib/site.sh 的 FJU_SECRETS_LOADED 讓 deploy.sh 不再 re-exec）。
 * 全是假值；APP_DB_PASSWORD 故意帶單引號，驗證 SQL 有正確跳脫。
 */
const FAKE_SECRETS: Record<string, string> = {
  FJU_SECRETS_LOADED: 'test',
  POSTGRES_USER: 'fake_owner',
  POSTGRES_PASSWORD: 'fake-owner-pw',
  POSTGRES_DB: 'fju',
  DATABASE_URL: 'postgres://fju_app:fake@postgres:5432/fju',
  DATABASE_URL_OWNER: 'postgres://fake_owner:fake@postgres:5432/fju',
  APP_DB_PASSWORD: "fake'app'pw",
  BETTER_AUTH_SECRET: 'fake',
  BETTER_AUTH_URL: 'https://test.fju.roy422.dev',
  GOOGLE_CLIENT_ID: 'fake',
  GOOGLE_CLIENT_SECRET: 'fake',
  FILES_ROOT: '/srv/fju/files',
  FILE_MAX_BYTES: '104857600',
  BUSINESS_CLOCK_OVERRIDE_ENABLED: 'true',
}

const FAKE_CURL = `#!/usr/bin/env bash
if [ -s "$HEALTH_FILE" ]; then cat "$HEALTH_FILE"; exit 0; fi
exit 7
`

type Scenario = {
  failUp?: boolean
  failMigrate?: boolean
  failPull?: boolean
  failPg?: boolean
  badHealth?: boolean
  /** 部署鎖被別人拿著。 */
  lockBusy?: boolean
  /** 有沒有前一版可以回滾。 */
  previous?: string | false
}

type Result = {
  code: number
  stdout: string
  stderr: string
  calls: string[]
  deployLog: string
  /** `docker compose exec` 從 stdin 收到的內容（fju_app 密碼同步的 SQL）。 */
  execStdin: string
}

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fju-deploy-exec-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

async function runDeploy(tag: string, scenario: Scenario = {}, args: string[] = []): Promise<Result> {
  const bin = path.join(dir, 'bin')
  const deployDir = path.join(dir, 'deploy')
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(deployDir, { recursive: true })

  const callsLog = path.join(dir, 'calls.log')
  const healthFile = path.join(dir, 'health.json')
  const execStdin = path.join(dir, 'exec-stdin.txt')
  fs.writeFileSync(callsLog, '')
  fs.writeFileSync(healthFile, '')
  fs.writeFileSync(execStdin, '')

  for (const [name, body] of [
    ['docker', FAKE_DOCKER],
    ['flock', FAKE_FLOCK],
    ['curl', FAKE_CURL],
  ] as const) {
    const file = path.join(bin, name)
    fs.writeFileSync(file, body)
    fs.chmodSync(file, 0o755)
  }

  const previous = scenario.previous === undefined ? 'ghcr.io/roy4222/fju-web:oldtag' : scenario.previous
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...FAKE_SECRETS,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    EXEC_STDIN: execStdin,
    FLOCK_BUSY: scenario.lockBusy ? '1' : '0',
    DEPLOY_DIR: deployDir,
    HEALTH_TIMEOUT_SECONDS: '4',
    HEALTH_URL: 'http://127.0.0.1:9/api/health',
    CALLS_LOG: callsLog,
    HEALTH_FILE: healthFile,
    FAKE_SCHEMA: '0002_test_migration',
    NEW_IMAGE: `ghcr.io/roy4222/fju-web:${tag}`,
    PREV_IMAGE: previous === false ? '' : previous,
    FAIL_UP: scenario.failUp ? '1' : '0',
    FAIL_MIGRATE: scenario.failMigrate ? '1' : '0',
    FAIL_PULL: scenario.failPull ? '1' : '0',
    FAIL_PG: scenario.failPg ? '1' : '0',
    FORCE_BAD_HEALTH: scenario.badHealth ? '1' : '0',
  }

  let code = 0
  let stdout = ''
  let stderr = ''
  try {
    const out = await exec('bash', [deploySh, '--site', 'test', tag, '--execute', ...args], { env, cwd: repoRoot })
    stdout = out.stdout
    stderr = out.stderr
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string }
    code = typeof e.code === 'number' ? e.code : 1
    stdout = e.stdout ?? ''
    stderr = e.stderr ?? ''
  }

  const deployLogPath = path.join(deployDir, 'deploy_log')
  return {
    code,
    stdout,
    stderr,
    calls: fs.readFileSync(callsLog, 'utf8').split('\n').filter(Boolean),
    deployLog: fs.existsSync(deployLogPath) ? fs.readFileSync(deployLogPath, 'utf8') : '',
    execStdin: fs.readFileSync(execStdin, 'utf8'),
  }
}

const upAppCalls = (calls: string[]) => calls.filter((c) => /^compose up .*app worker/.test(c))

describe('順利部署', () => {
  it('七步走完、deploy_log 記 deployed', async () => {
    const result = await runDeploy('newtag')
    expect(result.code, result.stderr).toBe(0)
    expect(result.calls.some((c) => c.startsWith('compose pull'))).toBe(true)
    expect(result.calls.some((c) => c.startsWith('compose run --rm migrate'))).toBe(true)
    expect(result.deployLog).toContain('deployed')
    expect(result.deployLog).toContain('newtag')
    expect(result.deployLog).toContain('0002_test_migration')
    expect(result.deployLog).not.toContain('rollback')
  })

  it('app 與 worker 是用 --no-deps 起的（migration 第 4 步已經跑過）', async () => {
    const result = await runDeploy('newtag')
    const ups = upAppCalls(result.calls)
    expect(ups.length).toBeGreaterThan(0)
    for (const call of ups) {
      expect(call, `這次 up 沒有 --no-deps：${call}`).toContain('--no-deps')
    }
  })
})

describe('R4：啟動新版失敗', () => {
  it('不是直接被 set -e 帶走——會走補償流程並留下紀錄', async () => {
    const result = await runDeploy('newtag', { failUp: true })
    expect(result.code).not.toBe(0)
    expect(result.deployLog, 'deploy_log 不該是空的').not.toBe('')
    expect(result.deployLog).toContain('rollback-start')
    expect(result.deployLog).toContain('start-failed')
    expect(result.deployLog).toContain('rollback-done')
  })

  it('回滾真的把 APP_IMAGE 換回前一版再啟動', async () => {
    const result = await runDeploy('newtag', { failUp: true })
    expect(result.stderr).toContain('回滾到 ghcr.io/roy4222/fju-web:oldtag')
    // 第一次 up 用新映像失敗，第二次（回滾）必須成功。
    expect(upAppCalls(result.calls).length).toBe(2)
    expect(result.deployLog).toContain('healthy')
  })

  it('沒有前一版可回滾時明講，不假裝成功', async () => {
    const result = await runDeploy('newtag', { failUp: true, previous: false })
    expect(result.code).not.toBe(0)
    expect(result.deployLog).toContain('rollback-skipped')
    expect(result.deployLog).toContain('no-previous')
    expect(result.stderr).toContain('需要人介入')
  })

  it('postgres 起不來也走同一條補償流程', async () => {
    const result = await runDeploy('newtag', { failPg: true })
    expect(result.code).not.toBe(0)
    expect(result.deployLog).toContain('postgres-start-failed')
    expect(result.deployLog).toContain('rollback-done')
  })
})

describe('R5：回滾不可以重跑舊 migration', () => {
  it('整個回滾過程沒有再執行過 migrate', async () => {
    const result = await runDeploy('newtag', { badHealth: true })
    // migrator 只有第 4 步那一次明確執行（`compose pull … migrate` 只是拉映像，不算執行）。
    const executed = result.calls.filter((c) => /^compose run\b/.test(c))
    expect(executed).toHaveLength(1)
    expect(executed[0]).toMatch(/^compose run --rm migrate/)
    // 任何 `up` 都不能把 migrate 帶起來。
    for (const call of result.calls.filter((c) => /^compose up\b/.test(c))) {
      expect(call, `這次 up 會啟動 migrate：${call}`).not.toMatch(/\bmigrate\b/)
    }
  })

  it('回滾的 up 帶 --no-deps，不會讓 compose 去滿足 migrate 依賴', async () => {
    const result = await runDeploy('newtag', { badHealth: true })
    const ups = upAppCalls(result.calls)
    expect(ups).toHaveLength(2)
    expect(ups[1]).toContain('--no-deps')
  })

  it('健康失敗時回滾到舊映像並重跑健康判定，schema 維持新的', async () => {
    const result = await runDeploy('newtag', { badHealth: true })
    expect(result.code).not.toBe(0)
    expect(result.deployLog).toContain('health-failed')
    expect(result.deployLog).toContain('rollback-done')
    expect(result.deployLog).toContain('ghcr.io/roy4222/fju-web:oldtag')
    // 回滾後的健康判定仍以 migrate 這次輸出的 schema 比對，通過才記 healthy。
    expect(result.deployLog).toContain('healthy')
  })
})

describe('更前面的步驟失敗就不會動到 app', () => {
  it('migrate 失敗直接中止，舊 app 繼續跑，不啟動新版', async () => {
    const result = await runDeploy('newtag', { failMigrate: true })
    expect(result.code).not.toBe(0)
    expect(upAppCalls(result.calls)).toHaveLength(0)
  })

  it('pull 失敗直接中止', async () => {
    const result = await runDeploy('newtag', { failPull: true })
    expect(result.code).not.toBe(0)
    expect(result.calls.some((c) => c.startsWith('compose run --rm migrate'))).toBe(false)
    expect(upAppCalls(result.calls)).toHaveLength(0)
  })
})

describe('fju_app 密碼同步（第一次部署靠它連上資料庫）', () => {
  it('migrate 之後、啟動 app 之前，把 APP_DB_PASSWORD 從 stdin 餵給 psql', async () => {
    const result = await runDeploy('newtag')
    expect(result.code, result.stderr).toBe(0)
    const migrateAt = result.calls.findIndex((c) => c.startsWith('compose run --rm migrate'))
    const execAt = result.calls.findIndex((c) => c.startsWith('compose exec -T postgres'))
    const upAt = result.calls.findIndex((c) => /^compose up .*app worker/.test(c))
    expect(migrateAt).toBeGreaterThanOrEqual(0)
    expect(execAt).toBeGreaterThan(migrateAt)
    expect(upAt).toBeGreaterThan(execAt)
    // 單引號要雙寫，不能把 SQL 字串提早結束。
    expect(result.execStdin).toContain("ALTER ROLE fju_app PASSWORD 'fake''app''pw';")
  })

  it('密碼只走 stdin：任何一次 docker 呼叫的指令列、stdout、stderr 都看不到它', async () => {
    const result = await runDeploy('newtag')
    for (const call of result.calls) {
      expect(call).not.toContain("fake'app'pw")
      expect(call).not.toContain('fake-owner-pw')
    }
    expect(result.stdout).not.toContain("fake'app'pw")
    expect(result.stderr).not.toContain("fake'app'pw")
  })

  it('少了必要的鍵就在動任何東西之前停下，只印鍵名', async () => {
    const bin = path.join(dir, 'bin')
    fs.mkdirSync(bin, { recursive: true })
    const fakeDocker = path.join(bin, 'docker')
    fs.writeFileSync(fakeDocker, '#!/usr/bin/env bash\necho "docker 不該被呼叫" >&2\nexit 99\n')
    fs.chmodSync(fakeDocker, 0o755)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...FAKE_SECRETS,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      DEPLOY_DIR: path.join(dir, 'deploy'),
    }
    delete env.APP_DB_PASSWORD
    delete env.GOOGLE_CLIENT_SECRET
    let stderr = ''
    let code = 0
    try {
      await exec('bash', [deploySh, '--site', 'test', 'newtag', '--execute'], { env, cwd: repoRoot })
    } catch (error) {
      const e = error as { code?: number; stderr?: string }
      code = typeof e.code === 'number' ? e.code : 1
      stderr = e.stderr ?? ''
    }
    expect(code).not.toBe(0)
    expect(stderr).toMatch(/少了這些鍵.*APP_DB_PASSWORD.*GOOGLE_CLIENT_SECRET/)
    expect(stderr).not.toContain('docker 不該被呼叫')
  })
})

describe('--rollback：指定舊 tag 重部署', () => {
  it('不跑 migrate、不同步密碼，換上舊映像並記 rolled-back', async () => {
    const result = await runDeploy('oldtag2', {}, ['--rollback'])
    expect(result.code, result.stderr).toBe(0)
    expect(result.calls.filter((c) => /^compose run\b/.test(c))).toHaveLength(0)
    expect(result.calls.some((c) => c.startsWith('compose exec'))).toBe(false)
    expect(result.calls.some((c) => c.startsWith('compose pull app worker'))).toBe(true)
    expect(result.calls.some((c) => /^compose pull .*migrate/.test(c))).toBe(false)
    for (const call of upAppCalls(result.calls)) expect(call).toContain('--no-deps')
    expect(result.deployLog).toMatch(/\trolled-back\toldtag2\t/)
    expect(result.deployLog).toContain('unchanged')
  })
})

describe('部署鎖', () => {
  it('拿不到鎖就以 75 結束，什麼都不動（auto-deploy 看到 75 會下一輪再試）', async () => {
    const result = await runDeploy('newtag', { lockBusy: true })
    expect(result.code).toBe(75)
    expect(result.calls.some((c) => c.startsWith('compose pull'))).toBe(false)
    expect(result.deployLog).toBe('')
  })
})
