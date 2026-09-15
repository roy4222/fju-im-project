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
      *) exit 0 ;;
    esac
    ;;
  *) exit 0 ;;
esac
`

const FAKE_FLOCK = `#!/usr/bin/env bash
exit 0
`

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
  /** 有沒有前一版可以回滾。 */
  previous?: string | false
}

type Result = { code: number; stdout: string; stderr: string; calls: string[]; deployLog: string }

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
  fs.writeFileSync(callsLog, '')
  fs.writeFileSync(healthFile, '')

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
    PATH: `${bin}:${process.env.PATH ?? ''}`,
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
    const out = await exec('bash', [deploySh, tag, '--execute', ...args], { env, cwd: repoRoot })
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
