// AC-S-12：ops/status-envcheck.sh 在缺鍵時也要跑到底、產出鍵名清單。
// source 真正的 ops/lib/site.sh（不 mock）：只用它留給本機測試的 FJU_DEPLOY_USER、FJU_SECRETS_DIR 覆寫，
// PATH 最前面放假 doppler（執行 `--` 後面的指令並注入假秘密）。除此之外是乾淨環境、bash -u。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const script = path.join(repoRoot, 'ops/status-envcheck.sh')
const me = os.userInfo().username

// 假秘密的值都帶 FAKEVALUE，輸出裡一個都不能出現。
const REQUIRED: Record<string, string> = {
  POSTGRES_USER: 'FAKEVALUE-pguser',
  POSTGRES_PASSWORD: 'FAKEVALUE-pgpass',
  POSTGRES_DB: 'FAKEVALUE-db',
  DATABASE_URL: 'postgres://FAKEVALUE-u:FAKEVALUE-p@db/x',
  DATABASE_URL_OWNER: 'postgres://FAKEVALUE-o:FAKEVALUE-p@db/x',
  APP_DB_PASSWORD: 'FAKEVALUE-app',
  BETTER_AUTH_SECRET: 'FAKEVALUE-auth',
  BETTER_AUTH_URL: 'https://FAKEVALUE.example',
  GOOGLE_CLIENT_ID: 'FAKEVALUE-gid',
  GOOGLE_CLIENT_SECRET: 'FAKEVALUE-gsecret',
  FILES_ROOT: '/FAKEVALUE/files',
  FILE_MAX_BYTES: '1048576',
  BUSINESS_CLOCK_OVERRIDE_ENABLED: 'false',
}

let tmp: string
let secretsDir: string
let fakeBin: string
let out: string

function writeFakeDoppler(config: string, vars: Record<string, string>) {
  const assigns = Object.entries(vars)
    .map(([k, v]) => `${k}='${v}'`)
    .join(' ')
  fs.writeFileSync(
    path.join(fakeBin, 'doppler'),
    [
      '#!/usr/bin/env bash',
      '# 假 doppler：確認拿到 token，跳過 run 的選項，執行 -- 後面的指令並注入假秘密。',
      `echo called >> '${tmp}/doppler-calls'`,
      '[ -n "${DOPPLER_TOKEN:-}" ] || { echo "沒有 DOPPLER_TOKEN" >&2; exit 9; }',
      'while [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done',
      'shift',
      `exec env DOPPLER_CONFIG='${config}' DOPPLER_PROJECT='fju-im-capstone' ${assigns} "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
}

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', ['-u', ...args], {
    cwd: tmp,
    encoding: 'utf8',
    env: {
      NODE_ENV: 'test',
      PATH: `${fakeBin}:${process.env.PATH}`,
      HOME: tmp,
      FJU_DEPLOY_USER: me,
      FJU_SECRETS_DIR: secretsDir,
      ...env,
    },
  })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

const dopplerCalls = () => (fs.existsSync(path.join(tmp, 'doppler-calls')) ? fs.readFileSync(path.join(tmp, 'doppler-calls'), 'utf8').split('\n').filter(Boolean).length : 0)

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fju-envcheck-'))
  secretsDir = path.join(tmp, 'secrets')
  fakeBin = path.join(tmp, 'bin')
  fs.mkdirSync(secretsDir)
  fs.mkdirSync(fakeBin)
  fs.writeFileSync(path.join(secretsDir, 'doppler-prod.token'), 'dp.st.prd.FAKETOKENFAKETOKENFAKETOKEN\n', { mode: 0o600 })
  out = path.join(tmp, 'envcheck', 'prod.json')
  fs.mkdirSync(path.dirname(out))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('AC-S-12 正式站設定檢查', () => {
  it('缺 GOOGLE_CLIENT_SECRET、多 E2E_ADMIN_EMAIL：跑到底、結束碼 0、只有鍵名', () => {
    const vars: Record<string, string> = { ...REQUIRED, E2E_ADMIN_EMAIL: 'FAKEVALUE-admin' }
    delete vars.GOOGLE_CLIENT_SECRET
    writeFakeDoppler('prd', vars)

    const r = run([script, 'prod', '--out', out])
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    const text = fs.readFileSync(out, 'utf8')
    const result = JSON.parse(text)
    expect(Object.keys(result)).toEqual(['site', 'checkedAt', 'missing', 'forbiddenPresent', 'flags'])
    expect(result.site).toBe('prod')
    expect(Number.isNaN(Date.parse(result.checkedAt))).toBe(false)
    expect(result.missing).toEqual(['GOOGLE_CLIENT_SECRET'])
    expect(result.forbiddenPresent).toEqual(['E2E_ADMIN_EMAIL'])
    expect(result.flags).toEqual({ REGISTRATION_OPEN: 'absent', BUSINESS_CLOCK_OVERRIDE_ENABLED: 'false' })
    // 檔案、畫面輸出都沒有任何值
    for (const s of [text, r.stdout, r.stderr]) {
      expect(s).not.toContain('FAKEVALUE')
      expect(s).not.toContain('FAKETOKEN')
    }
    expect(fs.statSync(out).mode & 0o777).toBe(0o644)
    expect(dopplerCalls()).toBe(1)
  })

  it('全部齊、旗標不是 false：missing 空、flags 是 other；空值的必要鍵算缺', () => {
    writeFakeDoppler('prd', { ...REQUIRED, FILES_ROOT: '', REGISTRATION_OPEN: 'true', BUSINESS_CLOCK_OVERRIDE_ENABLED: 'true' })
    const r = run([script, 'prod', '--out', out])
    expect(r.code).toBe(0)
    const result = JSON.parse(fs.readFileSync(out, 'utf8'))
    expect(result.missing).toEqual(['FILES_ROOT'])
    expect(result.forbiddenPresent).toEqual([])
    expect(result.flags).toEqual({ REGISTRATION_OPEN: 'other', BUSINESS_CLOCK_OVERRIDE_ENABLED: 'other' })
    expect(fs.readFileSync(out, 'utf8')).not.toContain('true')
  })

  it('REGISTRATION_OPEN=false 回 false；BUSINESS_CLOCK_OVERRIDE_ENABLED 缺時旗標是 other、也列進 missing', () => {
    const vars: Record<string, string> = { ...REQUIRED, REGISTRATION_OPEN: 'false' }
    delete vars.BUSINESS_CLOCK_OVERRIDE_ENABLED
    writeFakeDoppler('prd', vars)
    expect(run([script, 'prod', '--out', out]).code).toBe(0)
    const result = JSON.parse(fs.readFileSync(out, 'utf8'))
    expect(result.flags).toEqual({ REGISTRATION_OPEN: 'false', BUSINESS_CLOCK_OVERRIDE_ENABLED: 'other' })
    expect(result.missing).toEqual(['BUSINESS_CLOCK_OVERRIDE_ENABLED'])
  })

  it('token 是別站的（DOPPLER_CONFIG=stg）：結束碼非 0、不寫檔', () => {
    writeFakeDoppler('stg', REQUIRED)
    const r = run([script, 'prod', '--out', out])
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('stg')
    expect(fs.existsSync(out)).toBe(false)
  })

  it('反例：經 ops/site.sh prod 跑，會在 site_verify_secrets 就退出、沒有輸出檔', () => {
    const vars: Record<string, string> = { ...REQUIRED }
    delete vars.GOOGLE_CLIENT_SECRET
    writeFakeDoppler('prd', vars)
    const r = run([path.join(repoRoot, 'ops/site.sh'), 'prod', 'bash', script, 'prod', '--out', out])
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('GOOGLE_CLIENT_SECRET')
    expect(fs.existsSync(out)).toBe(false)
  })

  it('不是 deploy 身分：什麼都還沒做就停、沒呼叫 doppler', () => {
    writeFakeDoppler('prd', REQUIRED)
    const r = run([script, 'prod', '--out', out], { FJU_DEPLOY_USER: `${me}-not` })
    expect(r.code).toBe(1)
    expect(fs.existsSync(out)).toBe(false)
    expect(dopplerCalls()).toBe(0)
  })

  it('直接帶 --inside（不在 doppler run 裡）會拒絕', () => {
    const r = run([script, 'prod', '--inside', '--out', out])
    expect(r.code).toBe(1)
    expect(fs.existsSync(out)).toBe(false)
  })

  it('bash -n 通過、--help 印用法、沒給站台就停', () => {
    expect(spawnSync('bash', ['-n', script]).status).toBe(0)
    const help = run([script, '--help'])
    expect(help.code).toBe(0)
    expect(help.stdout).toContain('status-envcheck.sh prod')
    expect(run([script]).code).toBe(1)
  })
})
