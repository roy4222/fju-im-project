import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const exec = promisify(execFile)
const repoRoot = path.join(import.meta.dirname, '..', '..', '..')
const script = path.join(repoRoot, 'ops/codex-e2e.sh')

/**
 * 票 3b（#244）：ops/codex-e2e.sh 怎麼把帳密交給 Codex。
 *
 * 不碰真的 Doppler 與 Codex：假 `doppler` 從環境變數回假值，假 `codex` 把收到的參數記下來、
 * 記下「有沒有拿到帳密環境變數」（不記值），再照 `-o` 寫一份報告。
 */

const EMAIL = 'e2e-secret@example.test'
const PASSWORD = 'e2e-very-secret-password-123'

const FAKE_DOPPLER = `#!/usr/bin/env bash
printf 'doppler %s\\n' "$*" >> "$CALLS_LOG"
[ "\${FAIL_DOPPLER:-0}" = 1 ] && { echo "Doppler Error: you must be logged in" >&2; exit 1; }
case "$3" in
  E2E_ADMIN_EMAIL) printf '%s\\n' "$FAKE_EMAIL" ;;
  E2E_ADMIN_PASSWORD) printf '%s\\n' "$FAKE_PASSWORD" ;;
  *) exit 1 ;;
esac
`

const FAKE_CODEX = `#!/usr/bin/env bash
report=""
prev=""
for arg in "$@"; do
  # 一個參數一行（提示有換行，換成 ⏎）；最後一個參數（完整提示）另存一份。
  printf 'ARG %s\\n' "\${arg//$'\\n'/⏎}" >> "$CALLS_LOG"
  printf '%s' "$arg" > "$PROMPT_LOG"
  [ "$prev" = "-o" ] && report="$arg"
  prev="$arg"
done
printf 'CODEX_ENV email=%s password=%s\\n' "\${E2E_ADMIN_EMAIL:+set}" "\${E2E_ADMIN_PASSWORD:+set}" >> "$CALLS_LOG"
body="# 驗收報告\\n\\n總結：通過 7、不通過 0\\n"
if [ "\${LEAK:-0}" = 1 ]; then body="$body\\n密碼是 $E2E_ADMIN_PASSWORD\\n"; fi
printf "$body" > "$report"
exit "\${CODEX_EXIT:-0}"
`

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fju-codex-e2e-'))
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'doppler'), FAKE_DOPPLER, { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'codex'), FAKE_CODEX, { mode: 0o755 })
  const skill = path.join(dir, 'home', '.codex', 'skills', 'playwright')
  fs.mkdirSync(skill, { recursive: true })
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '# fake')
  fs.writeFileSync(path.join(dir, 'checklist.md'), '# 第 1 站\n\n1. 打開 https://test.fju.roy422.dev/login\n')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

async function run(env: Record<string, string> = {}, checklist = path.join(dir, 'checklist.md')) {
  const callsLog = path.join(dir, 'calls.log')
  fs.writeFileSync(callsLog, '')
  let code = 0
  let stdout = ''
  let stderr = ''
  try {
    const out = await exec('bash', [script, checklist], {
      cwd: repoRoot,
      // 刻意不帶 process.env：證明腳本不靠呼叫者環境裡的任何東西（例如真的 E2E_* 值）。
      env: {
        NODE_ENV: 'test',
        PATH: `${path.join(dir, 'bin')}:${process.env.PATH ?? ''}`,
        HOME: path.join(dir, 'home'),
        CALLS_LOG: callsLog,
        PROMPT_LOG: path.join(dir, 'prompt.txt'),
        CODEX_E2E_OUT: path.join(dir, 'out'),
        FAKE_EMAIL: EMAIL,
        FAKE_PASSWORD: PASSWORD,
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
  const calls = fs.readFileSync(callsLog, 'utf8').split('\n').filter(Boolean)
  const args = calls.filter((c) => c.startsWith('ARG ')).map((c) => c.slice(4))
  return { code, stdout, stderr, calls, args }
}

function reportFiles(): string[] {
  const out = path.join(dir, 'out')
  if (!fs.existsSync(out)) return []
  return fs.readdirSync(out).map((run) => path.join(out, run, 'report.md'))
}

describe('ops/codex-e2e.sh', () => {
  it('從 Doppler stg 取兩個鍵，以 gpt-6-sol 跑 codex exec，報告寫進輸出目錄', async () => {
    const r = await run()
    expect(r.code, r.stderr).toBe(0)
    expect(r.calls).toContain('doppler secrets get E2E_ADMIN_EMAIL --plain --project fju-im-capstone --config stg')
    expect(r.calls).toContain('doppler secrets get E2E_ADMIN_PASSWORD --plain --project fju-im-capstone --config stg')

    expect(r.args[0]).toBe('exec')
    const flag = (name: string) => r.args[r.args.indexOf(name) + 1]
    expect(flag('-m')).toBe('gpt-6-sol')
    expect(flag('-s')).toBe('workspace-write')
    expect(r.args).toContain('--ephemeral')
    expect(r.args).toContain('--skip-git-repo-check')
    expect(r.args).toContain('sandbox_workspace_write.network_access=true')
    expect(flag('-C')).toMatch(new RegExp(`^${path.join(dir, 'out')}/\\d{8}-\\d{6}-checklist$`))
    expect(flag('-o')).toBe(path.join(flag('-C')!, 'report.md'))

    const [report] = reportFiles()
    expect(fs.readFileSync(report!, 'utf8')).toContain('總結：通過 7、不通過 0')
    expect(r.stdout).toContain('總結：通過 7、不通過 0')
  })

  it('帳密只以環境變數交給 codex：參數、輸出都看不到值', async () => {
    const r = await run()
    expect(r.calls).toContain('CODEX_ENV email=set password=set')
    for (const text of [...r.args, r.stdout, r.stderr]) {
      expect(text).not.toContain(PASSWORD)
      expect(text).not.toContain(EMAIL)
    }
  })

  it('提示只准打測試站、禁止正式站與印出密碼，並附上清單內容', async () => {
    const r = await run()
    expect(r.code, r.stderr).toBe(0)
    const prompt = fs.readFileSync(path.join(dir, 'prompt.txt'), 'utf8')
    expect(prompt).toContain('~/.codex/skills/playwright')
    expect(prompt).toContain('只能開 https://test.fju.roy422.dev')
    expect(prompt).toContain('絕對不得開啟、連線或送出任何請求到正式站 https://fju.roy422.dev')
    expect(prompt).toContain('都不得出現密碼')
    expect(prompt).toContain('"$E2E_ADMIN_PASSWORD"')
    expect(prompt).toContain('<checklist>\n# 第 1 站')
  })

  it('清單裡有正式站網址就拒絕，連 Doppler 都不問', async () => {
    const prodList = path.join(dir, 'prod.md')
    fs.writeFileSync(prodList, '1. 打開 https://fju.roy422.dev/login\n')
    const r = await run({}, prodList)
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('正式站網址')
    expect(r.calls).toEqual([])
  })

  it('Doppler 取不到就清楚報錯（講鍵名），不跑 codex', async () => {
    const r = await run({ FAIL_DOPPLER: '1' })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('取不到 E2E_ADMIN_EMAIL')
    expect(r.args).toEqual([])
  })

  it('密碼不到 16 字元就不跑', async () => {
    const r = await run({ FAKE_PASSWORD: 'too-short' })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('不到 16 個字元')
    expect(r.args).toEqual([])
  })

  it('找不到清單就停', async () => {
    const r = await run({}, path.join(dir, 'nope.md'))
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('找不到驗收清單')
    expect(r.calls).toEqual([])
  })

  it('報告裡出現密碼：遮掉、以非 0 結束，而且錯誤訊息本身不含密碼', async () => {
    const r = await run({ LEAK: '1' })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('輸出裡出現了密碼')
    expect(r.stderr).not.toContain(PASSWORD)
    const [report] = reportFiles()
    const text = fs.readFileSync(report!, 'utf8')
    expect(text).not.toContain(PASSWORD)
    expect(text).toContain('[已遮蔽]')
  })

  it('codex 失敗就以非 0 結束', async () => {
    const r = await run({ CODEX_EXIT: '3' })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('codex exec 以 3 結束')
  })
})
