import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const exec = promisify(execFile)
const repoRoot = path.join(import.meta.dirname, '..', '..', '..')
const autoDeploySh = path.join(repoRoot, 'ops/auto-deploy.sh')

/**
 * 測試站自動部署（2026-09-24）：VM 上的 systemd timer 每 2 分鐘跑 ops/auto-deploy.sh。
 *
 * 不碰 Docker daemon：假的 `docker` 回答「:main 是哪個 SHA」「測試站目前跑哪個映像」，
 * 其餘 compose 呼叫照 deploy-execute 測試的方式模擬，所以 auto-deploy 會真的一路呼叫到
 * ops/deploy.sh --execute（秘密用假值，FJU_SECRETS_LOADED 讓它不去找 Doppler）。
 */

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

const FAKE_DOCKER = `#!/usr/bin/env bash
set -u
printf '%s\\n' "$*" >> "$CALLS_LOG"
case "$1" in
  pull)
    [ "\${FAIL_CHANNEL_PULL:-0}" = 1 ] && exit 1
    exit 0
    ;;
  image)
    if printf '%s' "$*" | grep -q 'Labels'; then printf '%s' "$MAIN_SHA"; exit 0; fi
    printf 'sha256:%s' "$(printf '%s' "\${@: -1}" | cksum | tr -d ' ' | head -c 12)"
    ;;
  inspect)
    printf '%s' "\${RUNNING_IMAGE:-}"
    ;;
  compose)
    shift
    case "$1" in
      ps) printf '%s\\n' "\${RUNNING_IMAGE:-}" ;;
      run)
        [ "\${FAIL_MIGRATE:-0}" = 1 ] && exit 3
        echo "SCHEMA_VERSION=0002_test_migration"
        ;;
      exec) cat > /dev/null ;;
      up)
        if printf '%s ' "$@" | grep -q ' postgres'; then exit 0; fi
        # 跑起來的 worker 回報自己的版本與剛剛的心跳（票 28 起部署預設判完整六項）。
        printf '{"ok":true,"commit":"%s","imageDigest":"%s","schemaVersion":"0002_test_migration","worker":{"version":"%s","lastTickAt":"%s"}}' \\
          "\${APP_IMAGE##*:}" "\${IMAGE_DIGEST:-}" "\${APP_IMAGE##*:}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$HEALTH_FILE"
        ;;
      *) exit 0 ;;
    esac
    ;;
  *) exit 0 ;;
esac
`

const FAKE_CURL = `#!/usr/bin/env bash
if [ -s "$HEALTH_FILE" ]; then cat "$HEALTH_FILE"; exit 0; fi
exit 7
`

const FAKE_FLOCK = `#!/usr/bin/env bash
exit 0
`

const FAKE_SECRETS: Record<string, string> = {
  FJU_SECRETS_LOADED: 'test',
  // 腳本會擋掉非 deploy 身分（ops/lib/site.sh 的 require_deploy_user）；測試用目前的帳號當 deploy。
  FJU_DEPLOY_USER: os.userInfo().username,
  POSTGRES_USER: 'fake_owner',
  POSTGRES_PASSWORD: 'fake',
  POSTGRES_DB: 'fju',
  DATABASE_URL: 'postgres://fju_app:fake@postgres:5432/fju',
  DATABASE_URL_OWNER: 'postgres://fake_owner:fake@postgres:5432/fju',
  APP_DB_PASSWORD: 'fake',
  BETTER_AUTH_SECRET: 'fake',
  BETTER_AUTH_URL: 'https://test.fju.roy422.dev',
  GOOGLE_CLIENT_ID: 'fake',
  GOOGLE_CLIENT_SECRET: 'fake',
  FILES_ROOT: '/srv/fju/files',
  FILE_MAX_BYTES: '104857600',
  BUSINESS_CLOCK_OVERRIDE_ENABLED: 'true',
}

type World = {
  mainSha?: string
  running?: string
  failMigrate?: boolean
  failChannelPull?: boolean
}

let dir: string
let deployDir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fju-auto-deploy-'))
  deployDir = path.join(dir, 'deploy')
  fs.mkdirSync(deployDir, { recursive: true })
  const secrets = path.join(dir, 'secrets')
  fs.mkdirSync(secrets, { recursive: true })
  // auto-deploy 只檢查 token 檔存在，不讀內容。
  fs.writeFileSync(path.join(secrets, 'doppler-test.token'), 'not-a-real-token', { mode: 0o600 })
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  for (const [name, body] of [
    ['docker', FAKE_DOCKER],
    ['curl', FAKE_CURL],
    ['flock', FAKE_FLOCK],
  ] as const) {
    fs.writeFileSync(path.join(bin, name), body)
    fs.chmodSync(path.join(bin, name), 0o755)
  }
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

/** 假裝測試站已經手動部署過一次（auto-deploy 的啟用條件）。 */
function markManualDeploy() {
  fs.appendFileSync(path.join(deployDir, 'deploy_log'), `2026-09-24T00:00:00Z\tdeployed\t${'0'.repeat(40)}\tlimited-no-worker\tsha256:x\t0002\n`)
}

async function runAuto(world: World = {}) {
  const callsLog = path.join(dir, 'calls.log')
  const healthFile = path.join(dir, 'health.json')
  fs.writeFileSync(callsLog, '')
  fs.writeFileSync(healthFile, '')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...FAKE_SECRETS,
    PATH: `${path.join(dir, 'bin')}:${process.env.PATH ?? ''}`,
    FJU_ROOT: dir,
    FJU_SECRETS_DIR: path.join(dir, 'secrets'),
    DEPLOY_DIR: deployDir,
    HEALTH_URL: 'http://127.0.0.1:9/api/health',
    HEALTH_TIMEOUT_SECONDS: '4',
    CALLS_LOG: callsLog,
    HEALTH_FILE: healthFile,
    MAIN_SHA: world.mainSha ?? SHA_A,
    RUNNING_IMAGE: world.running ?? 'ghcr.io/roy4222/fju-web:' + '0'.repeat(40),
    FAIL_MIGRATE: world.failMigrate ? '1' : '0',
    FAIL_CHANNEL_PULL: world.failChannelPull ? '1' : '0',
  }
  let code = 0
  let stdout = ''
  try {
    stdout = (await exec('bash', [autoDeploySh], { env, cwd: repoRoot })).stdout
  } catch (error) {
    const e = error as { code?: number; stdout?: string }
    code = typeof e.code === 'number' ? e.code : 1
    stdout = e.stdout ?? ''
  }
  const read = (name: string) =>
    fs.existsSync(path.join(deployDir, name)) ? fs.readFileSync(path.join(deployDir, name), 'utf8') : ''
  return {
    code,
    stdout,
    calls: fs.readFileSync(callsLog, 'utf8').split('\n').filter(Boolean),
    deployLog: read('deploy_log'),
    last: read('auto-deploy.last').trim(),
    autoLog: read('auto-deploy.log'),
  }
}

describe('ops/auto-deploy.sh：什麼時候不動作', () => {
  it('測試站還沒手動部署過 → 不拉映像、不部署', async () => {
    const r = await runAuto()
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('還沒有手動成功部署過')
    expect(r.calls).toHaveLength(0)
  })

  it('暫停檔存在 → 什麼都不做', async () => {
    markManualDeploy()
    fs.writeFileSync(path.join(deployDir, 'auto-deploy.paused'), '')
    const r = await runAuto()
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('暫停中')
    expect(r.calls).toHaveLength(0)
  })

  it(':main 的 SHA 跟上一次處理過的一樣 → 不部署', async () => {
    markManualDeploy()
    fs.writeFileSync(path.join(deployDir, 'auto-deploy.last'), `${SHA_A}\n`)
    const r = await runAuto({ mainSha: SHA_A })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('已是最新')
    expect(r.calls.some((c) => c.startsWith('compose'))).toBe(false)
  })

  it('測試站已經在跑這個 SHA → 只更新紀錄', async () => {
    markManualDeploy()
    const r = await runAuto({ mainSha: SHA_A, running: `ghcr.io/roy4222/fju-web:${SHA_A}` })
    expect(r.code).toBe(0)
    expect(r.last).toBe(SHA_A)
    expect(r.calls.some((c) => c.startsWith('compose'))).toBe(false)
  })

  it('拉不到 :main → 失敗並記錄，不部署', async () => {
    markManualDeploy()
    const r = await runAuto({ failChannelPull: true })
    expect(r.code).not.toBe(0)
    expect(r.autoLog).toContain('pull-failed')
    expect(r.calls.some((c) => c.startsWith('compose'))).toBe(false)
  })
})

describe('ops/auto-deploy.sh：有新映像', () => {
  it('用 :main 對應的完整 SHA 部署到測試站，成功後記下', async () => {
    markManualDeploy()
    const r = await runAuto({ mainSha: SHA_B })
    expect(r.code, r.stdout).toBe(0)
    expect(r.calls).toContain('pull --quiet ghcr.io/roy4222/fju-web:main')
    expect(r.calls.some((c) => c.startsWith('compose run --rm migrate'))).toBe(true)
    expect(r.deployLog).toMatch(new RegExp(`\\tdeployed\\t${SHA_B}\\t`))
    expect(r.last).toBe(SHA_B)
    expect(r.autoLog).toMatch(new RegExp(`\\tdeployed\\t${SHA_B}`))
  })

  it('部署失敗：記下 failed，同一個 SHA 下一輪不重試', async () => {
    markManualDeploy()
    const first = await runAuto({ mainSha: SHA_B, failMigrate: true })
    expect(first.code).not.toBe(0)
    expect(first.autoLog).toMatch(new RegExp(`\\tfailed\\t${SHA_B}`))
    expect(first.last).toBe(SHA_B)

    const second = await runAuto({ mainSha: SHA_B, failMigrate: true })
    expect(second.code).toBe(0)
    expect(second.stdout).toContain('已是最新')
    expect(second.calls.some((c) => c.startsWith('compose'))).toBe(false)
  })

  it('只會部署測試站：腳本裡沒有任何通往正式站的路徑', () => {
    const source = fs.readFileSync(autoDeploySh, 'utf8')
    expect(source).toContain('site_setup test')
    expect(source).toMatch(/ops\/deploy\.sh" --site test "\$sha" --execute/)
    const code = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
    expect(code).not.toMatch(/--site prod|--site "\$|site_setup "\$/)
  })
})
