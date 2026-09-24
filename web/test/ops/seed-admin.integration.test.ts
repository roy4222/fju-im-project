import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const exec = promisify(execFile)
const repoRoot = path.join(import.meta.dirname, '..', '..', '..')
const seedSh = path.join(repoRoot, 'ops/seed-admin.sh')

/**
 * ops/seed-admin.sh（2026-09-24）：在某一站建立第一位管理員 A1。
 *
 * 不碰 Docker daemon：假 `docker` 記下每次呼叫，並回答「這一站正在跑哪個映像」。
 * 要證明的是：用正在跑的映像、在 migrate 容器裡跑 seed-a1.mjs、A1_* 只以名稱轉交
 * （值不進指令列也不印出來）、缺鍵只印鍵名、還沒部署就停。
 * seed-a1.mjs 本身的冪等（email 已存在就不動）見最後一個案例。
 */

const FAKE_DOCKER = `#!/usr/bin/env bash
set -u
printf '%s\\n' "$*" >> "$CALLS_LOG"
case "$1" in
  inspect) printf '%s' "\${RUNNING_IMAGE:-}"; [ -n "\${RUNNING_IMAGE:-}" ] || exit 1 ;;
  compose)
    printf 'APP_IMAGE=%s\\n' "\${APP_IMAGE:-}" >> "$CALLS_LOG"
    echo "A1 已建立：status=active、must_change_password=true、角色 admin。"
    ;;
esac
`

const FAKE_FLOCK = `#!/usr/bin/env bash
exit 0
`

const SECRETS: Record<string, string> = {
  FJU_SECRETS_LOADED: 'test',
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
  A1_EMAIL: 'a1-secret@example.test',
  A1_INITIAL_PASSWORD: 'very-secret-initial-pw',
}

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fju-seed-'))
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'flock'), FAKE_FLOCK, { mode: 0o755 })
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

async function runSeed(args: string[], env: Record<string, string | undefined>) {
  const callsLog = path.join(dir, 'calls.log')
  fs.writeFileSync(callsLog, '')
  let code = 0
  let stdout = ''
  let stderr = ''
  try {
    const out = await exec('bash', [seedSh, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${path.join(dir, 'bin')}:${process.env.PATH ?? ''}`,
        DEPLOY_DIR: path.join(dir, 'deploy'),
        CALLS_LOG: callsLog,
        ...env,
      },
    })
    stdout = out.stdout
    stderr = out.stderr
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string }
    code = typeof e.code === 'number' ? e.code : 1
    stdout = e.stdout ?? ''
    stderr = e.stderr ?? ''
  }
  return { code, stdout, stderr, calls: fs.readFileSync(callsLog, 'utf8').split('\n').filter(Boolean) }
}

describe('ops/seed-admin.sh', () => {
  it('用這一站正在跑的映像，在 migrate 容器裡跑 seed-a1.mjs', async () => {
    const r = await runSeed(['test'], { ...SECRETS, RUNNING_IMAGE: 'ghcr.io/roy4222/fju-web:abc' })
    expect(r.code, r.stderr).toBe(0)
    expect(r.calls).toContain('inspect --format {{.Config.Image}} fju-test-app')
    const run = r.calls.find((c) => c.startsWith('compose run'))
    expect(run).toBe(
      'compose run --rm --no-deps -e A1_EMAIL -e A1_INITIAL_PASSWORD migrate node migrate/web/scripts/seed-a1.mjs',
    )
    expect(r.calls).toContain('APP_IMAGE=ghcr.io/roy4222/fju-web:abc')
  })

  it('A1 的 email 與一次性密碼不進指令列、不印出來', async () => {
    const r = await runSeed(['test'], { ...SECRETS, RUNNING_IMAGE: 'ghcr.io/roy4222/fju-web:abc' })
    for (const text of [...r.calls, r.stdout, r.stderr]) {
      expect(text).not.toContain('very-secret-initial-pw')
      expect(text).not.toContain('a1-secret@example.test')
    }
  })

  it('有設 A1_NAME 才轉交它', async () => {
    const r = await runSeed(['test'], { ...SECRETS, A1_NAME: '系辦', RUNNING_IMAGE: 'img:1' })
    expect(r.calls.find((c) => c.startsWith('compose run'))).toContain('-e A1_NAME migrate')
  })

  it('少了 A1_* 就停，只印鍵名，不碰 docker', async () => {
    const env: Record<string, string | undefined> = { ...SECRETS, RUNNING_IMAGE: 'img:1' }
    delete env.A1_INITIAL_PASSWORD
    const r = await runSeed(['test'], env)
    expect(r.code).not.toBe(0)
    expect(r.stderr).toMatch(/少了這些鍵.*A1_INITIAL_PASSWORD/)
    expect(r.calls).toEqual([])
  })

  it('這一站還沒部署就停，不建帳號', async () => {
    const r = await runSeed(['test'], { ...SECRETS, RUNNING_IMAGE: '' })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('先完成第一次部署')
    expect(r.calls.some((c) => c.startsWith('compose'))).toBe(false)
  })

  it('站台只收 test 或 prod', async () => {
    const r = await runSeed(['staging'], SECRETS)
    expect(r.code).not.toBe(0)
    expect(r.stderr).toMatch(/test 或 prod/)
  })

  it('seed-a1.mjs 本身冪等：同一個 email 已存在就 rollback 並結束，不改任何東西', () => {
    const seed = fs.readFileSync(path.join(repoRoot, 'web/scripts/seed-a1.mjs'), 'utf8')
    const existsCheck = seed.indexOf('select id, status, must_change_password from users where email = $1')
    const firstInsert = seed.indexOf('insert into users')
    expect(existsCheck).toBeGreaterThan(0)
    expect(existsCheck).toBeLessThan(firstInsert)
    const branch = seed.slice(existsCheck, firstInsert)
    expect(branch).toContain("await client.query('rollback')")
    expect(branch).toContain('process.exit(0)')
  })

  it('映像裡有 seed-a1.mjs（跟 migrate.mjs 放在一起，共用 production 依賴）', () => {
    const dockerfile = fs.readFileSync(path.join(repoRoot, 'web/Dockerfile'), 'utf8')
    expect(dockerfile).toMatch(/COPY .*\/repo\/web\/scripts\/seed-a1\.mjs \.\/migrate\/web\/scripts\/seed-a1\.mjs/)
  })
})
