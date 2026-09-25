import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 票 28 演練腳本在 VM 測試站第一次實跑時的三個問題（修正後的行為）：
 *
 * 1. worker-stall：`docker compose start worker` 因為 worker 依賴 migrate（migrate 是 run --rm、沒有容器）而失敗，
 *    腳本直接結束、沒寫紀錄、worker 也沒回來。→ 改成 `docker start` 同一個容器；任何方式結束都把 worker 帶回、補一筆 fail。
 * 2. poison：worker 沒在跑時白等 300 秒。→ 先查 worker 心跳與 BUSINESS_CLOCK_OVERRIDE_ENABLED，不符直接判「前置不符」。
 * 3. disk80：沒設 APP_IMAGE，compose run 退回 `:local` 並試著 build。→ 從正在跑的 app 容器讀出映像 export，run 帶 --pull never。
 *
 * 不碰 Docker：docker、curl、flock 換成假的，假 docker 把每次呼叫（含當下的 APP_IMAGE）記到 calls.log。
 * 真實的 Compose 行為（依賴 migrate、映像退回 :local）由 ops/fault-drill-local.sh 在本機模擬站重現與驗證。
 */

const repoRoot = path.join(import.meta.dirname, '..', '..', '..')
const script = path.join(repoRoot, 'ops/fault-drill.sh')

const FAKE_DOCKER = `#!/usr/bin/env bash
printf 'APP_IMAGE=%s | %s\\n' "\${APP_IMAGE:-<unset>}" "$*" >> "$CALLS_LOG"
case "$1" in
  inspect)
    case "$*" in
      *'.Config.Image'*) echo 'ghcr.io/roy4222/fju-web:abc123' ;;
      *'.Config.Env'*) printf 'SECRET_THING=do-not-print\\nIMAGE_DIGEST=sha256:feed\\nBUSINESS_CLOCK_OVERRIDE_ENABLED=%s\\n' "\${FAKE_CLOCK:-true}" ;;
      *'.State.Running'*) echo false ;;
    esac
    ;;
  start) exit 0 ;;
  volume) exit 0 ;;
  compose)
    shift
    while [ "$1" = -p ] || [ "$1" = -f ]; do shift 2; done
    case "$1" in
      ps)
        case "$*" in
          *' app'*) echo appcid ;;
          *' worker'*) [ "\${NO_WORKER:-0}" = 1 ] || echo workercid ;;
        esac
        ;;
      stop) [ "\${FAIL_STOP:-0}" = 1 ] && { echo 'stop 爆炸' >&2; exit 5; }; exit 0 ;;
      exec) cat > /dev/null; exit 0 ;;
      run) echo 'STORAGE_MEASURED used_percent=87.5 level=warn80 drill=true'; exit 0 ;;
      *) exit 0 ;;
    esac
    ;;
esac
exit 0
`

// 假 curl：把 FAKE_HEALTH 寫到 -o 的檔、印 FAKE_CODE（跟 fault-drill.sh 的 health_code 用法一樣）。
const FAKE_CURL = `#!/usr/bin/env bash
out=""
while [ $# -gt 0 ]; do
  case "$1" in -o) out="$2"; shift ;; esac
  shift
done
printf '%s' "$FAKE_HEALTH" > "$out"
printf '%s' "\${FAKE_CODE:-200}"
`

let dir: string
let callsLog: string
let drillLog: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fju-fault-drill-'))
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  for (const [name, body] of [
    ['docker', FAKE_DOCKER],
    ['curl', FAKE_CURL],
    ['flock', '#!/bin/sh\nexit 0\n'],
  ] as const) {
    fs.writeFileSync(path.join(bin, name), body)
    fs.chmodSync(path.join(bin, name), 0o755)
  }
  callsLog = path.join(dir, 'calls.log')
  fs.writeFileSync(callsLog, '')
  drillLog = path.join(dir, 'drills', 'fault-drills.log')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const health = (lastTickAgoMs: number) =>
  JSON.stringify({
    ok: true,
    version: '1',
    commit: 'abc123',
    imageDigest: 'sha256:feed',
    schemaVersion: '0009',
    worker: { version: 'abc123', lastTickAt: new Date(Date.now() - lastTickAgoMs).toISOString() },
  })

function drill(name: string, env: Record<string, string> = {}) {
  const r = spawnSync('bash', [script, '--site', 'test', name, '--execute'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${path.join(dir, 'bin')}:${process.env.PATH ?? ''}`,
      CALLS_LOG: callsLog,
      // 已經在 Doppler 環境裡的樣子（ops/lib/site.sh）；身分守門用目前的帳號當 deploy。
      FJU_SECRETS_LOADED: 'test',
      FJU_DEPLOY_USER: os.userInfo().username,
      POSTGRES_USER: 'x', POSTGRES_PASSWORD: 'x', POSTGRES_DB: 'x', DATABASE_URL: 'x', DATABASE_URL_OWNER: 'x',
      APP_DB_PASSWORD: 'x', BETTER_AUTH_SECRET: 'x', BETTER_AUTH_URL: 'x', GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'x',
      FILES_ROOT: '/srv/fju/files', FILE_MAX_BYTES: '1', BUSINESS_CLOCK_OVERRIDE_ENABLED: 'true',
      DRILL_DIR: path.join(dir, 'drills'),
      DEPLOY_DIR: path.join(dir, 'deploy'),
      HEALTH_URL: 'http://127.0.0.1:9/api/health',
      WORKER_STALL_WAIT_SECONDS: '1',
      POLL_SECONDS: '1',
      HEALTH_TIMEOUT_SECONDS: '2',
      POISON_TIMEOUT_SECONDS: '2',
      FAKE_HEALTH: health(1_000),
      ...env,
    },
  })
  return {
    code: r.status,
    out: `${r.stdout}${r.stderr}`,
    calls: fs.readFileSync(callsLog, 'utf8').split('\n').filter(Boolean),
    log: fs.existsSync(drillLog) ? fs.readFileSync(drillLog, 'utf8').split('\n').filter(Boolean) : [],
  }
}

describe('worker-stall：任何方式結束都把 worker 帶回、都留紀錄', () => {
  it('停掉之後用 docker start 同一個容器帶回（不經 compose 的 depends_on）', () => {
    const r = drill('worker-stall') // /api/health 一直是 200：沒等到 503 → 判失敗，但 worker 要回來
    expect(r.code).not.toBe(0)
    expect(r.calls.some((c) => c.endsWith('| start workercid'))).toBe(true)
    expect(r.calls.some((c) => / compose .*start worker/.test(c) || / compose .*up .*worker/.test(c))).toBe(false)
    expect(r.log).toHaveLength(1)
    expect(r.log[0]).toContain('\tworker-stall\tfail\tghcr.io/roy4222/fju-web:abc123\t')
    expect(r.log[0]).toContain('還沒變 503')
  })

  it('停 worker 那一步就出錯（set -e 中斷）：trap 仍把 worker 帶回，並補一筆 fail', () => {
    const r = drill('worker-stall', { FAIL_STOP: '1' })
    expect(r.code).not.toBe(0)
    expect(r.calls.some((c) => c.endsWith('| start workercid'))).toBe(true)
    expect(r.log).toHaveLength(1)
    expect(r.log[0]).toMatch(/\tworker-stall\tfail\t.*腳本中途結束（結束碼 5）；worker 已重新啟動/)
  })

  it('演練前 worker 就沒在跑：前置不符，不去停也不去等', () => {
    const r = drill('worker-stall', { NO_WORKER: '1' })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('前置不符：worker 沒有在跑')
    expect(r.calls.some((c) => c.includes(' stop worker'))).toBe(false)
  })
})

describe('poison：前置不符就直接判失敗，不白等', () => {
  it('worker 心跳超過 60 秒：前置不符，沒有插任何到期工作', () => {
    const started = Date.now()
    const r = drill('poison', { FAKE_HEALTH: health(10 * 60_000), POISON_TIMEOUT_SECONDS: '300' })
    expect(Date.now() - started).toBeLessThan(20_000)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('前置不符：worker 心跳不新鮮')
    expect(r.out).toContain('docker start fju-test-worker')
    expect(r.calls.some((c) => c.includes(' exec -T postgres'))).toBe(false)
    expect(r.log[0]).toContain('\tpoison\tfail\t')
  })

  it('worker 容器的 BUSINESS_CLOCK_OVERRIDE_ENABLED 不是 true：前置不符，訊息寫出實際值', () => {
    const r = drill('poison', { FAKE_CLOCK: 'false' })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('BUSINESS_CLOCK_OVERRIDE_ENABLED 是「false」')
    // 讀容器環境時只取那一個鍵，其他值（秘密）不會被印出來。
    expect(r.out).not.toContain('do-not-print')
  })

  it('兩件都沒被撿就逾時：訊息指向 worker 的到期迴圈與 log，不再猜 BUSINESS_CLOCK', () => {
    const r = drill('poison', { POISON_TIMEOUT_SECONDS: '1' })
    expect(r.code).not.toBe(0)
    expect(r.log[0]).toContain('\tpoison\tfail\t')
  })
})

describe('disk80：用目前部署的映像，不退回 :local、不 build', () => {
  it('compose run 時 APP_IMAGE＝正在跑的 app 容器的映像，而且帶 --pull never；記憶體磁碟最後刪掉', () => {
    const r = drill('disk80')
    const run = r.calls.find((c) => / compose .*run --rm/.test(c))
    expect(run, r.calls.join('\n')).toBeTruthy()
    expect(run).toMatch(/^APP_IMAGE=ghcr\.io\/roy4222\/fju-web:abc123 \|/)
    expect(run).toContain('--pull never')
    expect(r.calls.some((c) => c.includes('volume rm -f fju-test-drill-disk80'))).toBe(true)
    // 假 psql 什麼都不回，所以這裡會判「不是警戒」；重點是有留紀錄、映像欄是真的映像。
    expect(r.log[0]).toContain('\tdisk80\tfail\tghcr.io/roy4222/fju-web:abc123\t')
  })
})
