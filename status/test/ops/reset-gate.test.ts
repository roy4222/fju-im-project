// AC-S-20：重置測試站專用金鑰的守門腳本（ops/fju-test-reset-gate）多放行不帶參數的 seed-demo。
// 守門腳本複製一份到暫存目錄，只把 SUDO 換成會記錄參數的假指令，其他照原檔跑；
// SSH_ORIGINAL_COMMAND 就是 ssh fju-reset 後面接的字。
// 另外驗 root 腳本（ops/fju-test-reset）的參數檢查：在「要用 root 跑」之前就擋，不需要 root。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const gateScript = path.join(repoRoot, 'ops/fju-test-reset-gate')
const resetScript = path.join(repoRoot, 'ops/fju-test-reset')
const SUDO_LINE = 'readonly SUDO=/usr/bin/sudo'

let tmp: string
let gate: string
let record: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-gate-'))
  record = path.join(tmp, 'sudo-args')
  const fakeSudo = path.join(tmp, 'fake-sudo')
  fs.writeFileSync(fakeSudo, `#!/bin/bash\nprintf '%s\\n' "$@" > '${record}'\n`, { mode: 0o755 })
  const src = fs.readFileSync(gateScript, 'utf8')
  expect(src).toContain(SUDO_LINE)
  gate = path.join(tmp, 'gate')
  fs.writeFileSync(gate, src.replace(SUDO_LINE, `readonly SUDO=${fakeSudo}`), { mode: 0o755 })
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function runGate(cmd: string) {
  // Next 的型別把 NODE_ENV 設成 ProcessEnv 的必填；子程序刻意給乾淨環境，所以用寬鬆的型別再轉。
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', SSH_ORIGINAL_COMMAND: cmd }
  const r = spawnSync('bash', [gate], { encoding: 'utf8', env: env as NodeJS.ProcessEnv })
  const passed = fs.existsSync(record) ? fs.readFileSync(record, 'utf8').trimEnd().split('\n') : null
  return { status: r.status, stderr: r.stderr, passed }
}

describe('守門腳本 fju-test-reset-gate（AC-S-20）', () => {
  it('seed-demo 交給 fju-test-reset seed-demo', () => {
    const r = runGate('seed-demo')
    expect(r.status).toBe(0)
    expect(r.passed).toEqual(['-n', '/usr/local/sbin/fju-test-reset', 'seed-demo'])
  })

  it('seed-demo x 拒絕：不接參數', () => {
    const r = runGate('seed-demo x')
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('seed-demo 不接參數')
    expect(r.passed).toBeNull()
  })

  it('seed-demo prod 拒絕：只准碰測試站', () => {
    const r = runGate('seed-demo prod')
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('只准碰測試站')
    expect(r.passed).toBeNull()
  })

  it('status、snapshot a 跟原本一樣放行', () => {
    expect(runGate('status').passed).toEqual(['-n', '/usr/local/sbin/fju-test-reset', 'status'])
    expect(runGate('snapshot a').passed).toEqual(['-n', '/usr/local/sbin/fju-test-reset', 'snapshot', 'a'])
  })

  it('其他寫法照舊拒絕', () => {
    for (const cmd of ['seed-demo ', ' seed-demo', 'seed-demo  x', 'seed-demo;id', 'seed-demo $(id)', 'Seed-demo', 'seeddemo', 'status x', 'snapshot', '']) {
      const r = runGate(cmd)
      expect(r.status, cmd).not.toBe(0)
      expect(r.passed, cmd).toBeNull()
    }
  })

  it('拒絕訊息列出可用的子命令含 seed-demo', () => {
    expect(runGate('nope').stderr).toContain('seed-demo')
  })
})

describe('root 腳本 fju-test-reset 的參數檢查', () => {
  function runReset(...args: string[]) {
    return spawnSync('bash', [resetScript, ...args], { encoding: 'utf8' })
  }

  it('兩支腳本語法正確', () => {
    for (const f of [gateScript, resetScript]) {
      expect(spawnSync('bash', ['-n', f]).status, f).toBe(0)
    }
  })

  it('seed-demo 帶參數、含 prod 在碰系統之前就拒絕', () => {
    const extra = runReset('seed-demo', 'x')
    expect(extra.status).not.toBe(0)
    expect(extra.stderr).toContain('seed-demo 不接參數')
    const prod = runReset('seed-demo', 'prod')
    expect(prod.status).not.toBe(0)
    expect(prod.stderr).toContain('參數含 prod')
  })

  it.skipIf(process.getuid?.() === 0)('seed-demo 是認得的子命令（非 root 停在身分檢查，不是用法錯誤）', () => {
    const r = runReset('seed-demo')
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('要用 root 跑')
    expect(r.stderr).not.toContain('用法')
  })
})
