import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * S-9：ops/status-install.sh（VM，sudo 一次）與 ops/status-prepare.sh（Mac mini）。
 *
 * 全部在本機跑、不需要 root：只跑 `bash -n`、`--help`、`--dry-run`、`--check-cloudflared-config`。
 * 會改系統的指令（docker run、useradd、systemctl enable、install、rsync…）換成只記錄呼叫的假指令，
 * 用來證明 --dry-run 一個都沒叫。對應 AC-S-14（記憶體不足就停）、AC-S-25(b)（第 10 步第二段的檢查）。
 */

const repoRoot = path.join(import.meta.dirname, '..', '..', '..')
const INSTALL = path.join(repoRoot, 'ops', 'status-install.sh')
const PREPARE = path.join(repoRoot, 'ops', 'status-prepare.sh')
const TEAM = 'royteam.cloudflareaccess.com'
const AUD = 'a1b2c3d4'.repeat(8)
const PUBKEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyOnlyForTests0123456789abcdefghij fju-status-publish'
const HOSTS = ['fju-status.roy422.dev', 'fju-status-vm.roy422.dev', 'fju-status-logs.roy422.dev', 'fju-status-db.roy422.dev']

// 這些指令在 --dry-run 一次都不能被叫到。
const FORBIDDEN = [
  'useradd', 'usermod', 'install', 'chown', 'chmod', 'mkdir', 'mv', 'cp', 'rm', 'ln', 'tee', 'mktemp',
  'ssh-keygen', 'openssl', 'runuser', 'sshd', 'curl', 'rsync', 'ssh', 'scp',
]
// docker／systemctl 只准唯讀的子命令。
const DOCKER_READONLY = /^docker (compose version|stats --no-stream|ps |inspect )/
const SYSTEMCTL_READONLY = /^systemctl is-(enabled|active) /

let dir: string
let bin: string
let callsLog: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fju-status-install-'))
  bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  callsLog = path.join(dir, 'calls.log')
  fs.writeFileSync(callsLog, '')
  for (const name of [...FORBIDDEN, 'docker', 'systemctl']) {
    const fake = path.join(bin, name)
    fs.writeFileSync(fake, `#!/bin/sh\necho "${name} $*" >> "$CALLS_LOG"\nexit 0\n`)
    fs.chmodSync(fake, 0o755)
  }
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function run(script: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      CALLS_LOG: callsLog,
      LANG: 'C.UTF-8',
      FJU_STATUS_APP_DIR: repoRoot,
      ...env,
    },
  })
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout }
}

const calls = () => fs.readFileSync(callsLog, 'utf8').split('\n').filter(Boolean)
const mutatingCalls = () =>
  calls().filter((c) => {
    if (c.startsWith('docker ')) return !DOCKER_READONLY.test(c)
    if (c.startsWith('systemctl ')) return !SYSTEMCTL_READONLY.test(c)
    return true
  })

const installArgs = (...extra: string[]) => [
  '--access-team', TEAM, '--access-aud', AUD, '--publish-pubkey', PUBKEY, ...extra,
]

function writeConfig(name: string, body: string) {
  const file = path.join(dir, name)
  fs.writeFileSync(file, body)
  return file
}

const access = (indent: string) =>
  [
    `${indent}originRequest:`,
    `${indent}  access:`,
    `${indent}    required: true`,
    `${indent}    teamName: royteam`,
    `${indent}    audTag:`,
    `${indent}      - ${AUD}`,
  ].join('\n')

// 照 S-4 產生器會產的樣子：四條 ingress 各帶 originRequest.access，最後一條 http_status:404。
const services = ['http://status-web:3000', 'http://beszel:8090', 'http://dozzle:8080', 'http://pghero:8080']
function goodConfig({ withoutAccessFor = '' } = {}) {
  const rules = HOSTS.map((h, i) => {
    const lines = [`  - hostname: ${h}`, `    service: ${services[i]}`]
    if (h !== withoutAccessFor) lines.push(access('    '))
    return lines.join('\n')
  })
  return ['tunnel: 00000000-0000-0000-0000-000000000000', 'credentials-file: /etc/cloudflared/tunnel.json', 'ingress:', ...rules, '  - service: http_status:404', ''].join('\n')
}

describe('兩支腳本：語法與 --help', () => {
  it.each([INSTALL, PREPARE])('bash -n %s', (script) => {
    const r = spawnSync('bash', ['-n', script], { encoding: 'utf8' })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })

  it('status-install.sh --help 印用法、不做任何事', () => {
    const r = run(INSTALL, ['--help'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('--dry-run')
    expect(r.stdout).toContain('--mem-available-override')
    expect(r.stdout).toContain('--check-cloudflared-config')
    expect(calls()).toEqual([])
  })

  it('status-prepare.sh --help 印用法、不做任何事', () => {
    const r = run(PREPARE, ['--help'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('--dry-run')
    expect(r.stdout).toContain('fju_status_publish')
    expect(calls()).toEqual([])
  })
})

describe('status-install.sh 參數', () => {
  it('team 網域格式不對就不收', () => {
    const r = run(INSTALL, ['--dry-run', '--access-team', 'royteam', '--access-aud', AUD, '--publish-pubkey', PUBKEY])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('cloudflareaccess.com')
    expect(calls()).toEqual([])
  })

  it('公鑰不是一整行 ssh-ed25519 就不收（擋住塞進 authorized_keys 的選項）', () => {
    const r = run(INSTALL, ['--dry-run', '--access-team', TEAM, '--access-aud', AUD, '--publish-pubkey', 'command="sh" ssh-ed25519 AAAA'])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('ssh-ed25519')
    expect(calls()).toEqual([])
  })

  it('不是 root 又沒帶 --dry-run：在任何動作之前停下，提示用 sudo', () => {
    if (process.getuid?.() === 0) return
    const r = run(INSTALL, installArgs('--mem-available-override', '8000'))
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('sudo')
    expect(r.out).not.toContain('步驟 1')
    expect(calls()).toEqual([])
  })
})

describe('status-install.sh --dry-run 只印不做', () => {
  it('十二步加 7b 都印出來，沒有叫任何會改系統的指令', () => {
    const r = run(INSTALL, installArgs('--dry-run', '--mem-available-override', '8000'))
    expect(r.code).toBe(0)
    for (const s of ['1', '2', '3', '4', '5', '6', '7', '7b', '8', '9', '10', '11', '12']) {
      expect(r.stdout).toContain(`步驟 ${s}：`)
    }
    expect(r.stdout).toContain('會執行：')
    expect(r.stdout).toContain('/srv/fju/status/diskprobe')
    expect(r.stdout).toContain('rrsync -wo /srv/fju/status/inbox')
    expect(r.stdout).toContain('/beszel_socket/beszel.sock')
    expect(r.stdout).toContain('fju-status-verify.roy422.dev')
    expect(r.stdout).toContain('docker cp')
    expect(r.stdout).toContain('--dry-run 結束：沒有建立或改動任何東西')
    expect(mutatingCalls()).toEqual([])
  })

  it('S-7 還沒合併（重置腳本沒有 seed-demo）：第 4 步印「跳過」', () => {
    const r = run(INSTALL, installArgs('--dry-run', '--mem-available-override', '8000'))
    const resetHasSeedDemo = fs.readFileSync(path.join(repoRoot, 'ops', 'fju-test-reset'), 'utf8').includes('seed-demo')
    if (!resetHasSeedDemo) expect(r.stdout).toContain('跳過 重置腳本還沒有 seed-demo')
    expect(mutatingCalls()).toEqual([])
  })
})

describe('第 1 步：可用記憶體 < 2.5 GB 就停（AC-S-14）', () => {
  it('--mem-available-override 2000：印出可用記憶體、停在第 1 步、什麼都沒建、結束碼非 0', () => {
    const r = run(INSTALL, installArgs('--dry-run', '--mem-available-override', '2000'))
    expect(r.code).not.toBe(0)
    expect(r.stdout).toContain('可用記憶體 2000 MB')
    expect(r.stdout).toContain('停止，什麼都沒建')
    expect(r.stdout).toContain('停在步驟 1')
    expect(r.stdout).not.toContain('步驟 2：')
    expect(r.stdout).not.toContain('會執行：')
    expect(mutatingCalls()).toEqual([])
  })

  it('門檻是 2560 MB：2559 停、2560 繼續', () => {
    expect(run(INSTALL, installArgs('--dry-run', '--mem-available-override', '2559')).code).not.toBe(0)
    const r = run(INSTALL, installArgs('--dry-run', '--mem-available-override', '2560'))
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('步驟 2：')
  })
})

describe('第 10 步第二段：cloudflared 設定的 access 區塊檢查（AC-S-25 b）', () => {
  const check = (file: string, ...extra: string[]) =>
    run(INSTALL, ['--check-cloudflared-config', file, '--access-team', TEAM, '--access-aud', AUD, ...extra])

  it('四條 ingress 都帶 originRequest.access：通過', () => {
    const r = check(writeConfig('good.yml', goodConfig()))
    expect(r.out).toContain('每條 ingress 都有 originRequest.access')
    expect(r.code).toBe(0)
  })

  it('拿掉其中一條的 access：判失敗，並指出是哪個網址', () => {
    const r = check(writeConfig('no-access.yml', goodConfig({ withoutAccessFor: 'fju-status-logs.roy422.dev' })))
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('fju-status-logs.roy422.dev')
    expect(r.out).toContain('access.required 不是 true')
    expect(r.out).not.toMatch(/✗ fju-status\.roy422\.dev/)
  })

  it('四條全部拿掉 access：四個網址都列出來', () => {
    const body = goodConfig().replace(/\n {4}originRequest:\n( {6}.*\n)+/g, '\n')
    expect(body).not.toContain('access')
    const r = check(writeConfig('stripped.yml', body))
    expect(r.code).not.toBe(0)
    for (const h of HOSTS) expect(r.out).toContain(`✗ ${h}：`)
  })

  it('AUD 不對、team 不對、少一個網址：都判失敗', () => {
    const wrongAud = check(writeConfig('aud.yml', goodConfig().replaceAll(AUD, 'f'.repeat(64))))
    expect(wrongAud.code).not.toBe(0)
    expect(wrongAud.out).toContain('audTag 不是恰好這一個 AUD')

    const wrongTeam = check(writeConfig('team.yml', goodConfig().replaceAll('teamName: royteam', 'teamName: other')))
    expect(wrongTeam.code).not.toBe(0)
    expect(wrongTeam.out).toContain('teamName 不是 royteam')

    const notRequired = check(writeConfig('req.yml', goodConfig().replace('required: true', 'required: false')))
    expect(notRequired.code).not.toBe(0)

    const missingHost = check(writeConfig('host.yml', goodConfig().replace('hostname: fju-status-db.roy422.dev', 'hostname: other.roy422.dev')))
    expect(missingHost.code).not.toBe(0)
    expect(missingHost.out).toContain('fju-status-db.roy422.dev：設定檔裡沒有這個網址')
  })

  it('audTag 多放別的 AUD：判失敗（同 team 其他 Access 應用程式的通行證也會被放行）', () => {
    const r = check(writeConfig('extra-aud.yml', goodConfig().replaceAll(`      - ${AUD}`, `      - ${'e'.repeat(64)}\n      - ${AUD}`)))
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('audTag 不是恰好這一個 AUD')
  })

  it('鍵名帶「.」假裝巢狀（cloudflared 會當成別的鍵、等於沒鎖）：判失敗', () => {
    const dotted = goodConfig({ withoutAccessFor: 'fju-status-db.roy422.dev' }).replace(
      '    service: http://pghero:8080',
      ['    service: http://pghero:8080', '    originRequest.access.required: true', '    originRequest.access.teamName: royteam', `    originRequest.access.audTag: [${AUD}]`].join('\n'),
    )
    const r = check(writeConfig('dotted.yml', dotted))
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('看不懂的寫法')

    const topLevel = `${goodConfig({ withoutAccessFor: 'fju-status-db.roy422.dev' })}"ingress.3.originRequest.access.required": true\n`
    expect(check(writeConfig('toplevel.yml', topLevel)).code).not.toBe(0)
  })

  it('同一個鍵寫兩次、用 tab 縮排：判失敗（看不懂就擋下）', () => {
    const dup = goodConfig().replace('        required: true', '        required: true\n        required: false')
    const r = check(writeConfig('dup.yml', dup))
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('同一個鍵寫了兩次')

    const tabbed = goodConfig().replace('        required: true', '\t\trequired: true')
    expect(check(writeConfig('tab.yml', tabbed)).code).not.toBe(0)
  })

  it('沒有 hostname、會轉給服務的 catch-all 也要有 access（不然它就是沒鎖的後門）', () => {
    const body = goodConfig().replace('  - service: http_status:404', '  - service: http://status-web:3000')
    const r = check(writeConfig('catchall.yml', body))
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('沒有 hostname')
  })

  it('同樣內容寫成 flow 樣式（{…}、[…]、引號）也認得', () => {
    const body = [
      'tunnel: x',
      'ingress:',
      ...HOSTS.map((h) => `- hostname: "${h}"\n  service: http://x:1\n  originRequest: { access: { required: true, teamName: 'royteam', audTag: ["${AUD}"] } }`),
      '- service: http_status:404',
      '',
    ].join('\n')
    const r = check(writeConfig('flow.yml', body))
    expect(r.out).toContain('每條 ingress 都有 originRequest.access')
    expect(r.code).toBe(0)
  })

  it('空檔或不存在：判失敗', () => {
    expect(check(path.join(dir, 'nope.yml')).code).not.toBe(0)
    expect(check(writeConfig('empty.yml', '')).code).not.toBe(0)
  })

  it('安裝流程第 10 步用 docker cp 取容器裡實際掛載的檔、用同一個檢查；不用 docker compose config', () => {
    const src = fs.readFileSync(INSTALL, 'utf8')
    const step10 = src.slice(src.indexOf('step 10 '), src.indexOf('step 11 '))
    expect(step10).toMatch(/docker cp "\$\{cf_cid\}:\/etc\/cloudflared\/config\.yml" -/)
    expect(step10).toContain('check_cloudflared_config "$mounted"')
    expect(step10).toContain('close_gate')
    expect(src).not.toMatch(/docker compose[^\n]* config\b/)
  })

  it('關門保證：起服務前就掛上「中途結束就關門」；自動更新 timer 要等守門通過才啟用', () => {
    const src = fs.readFileSync(INSTALL, 'utf8')
    const guard = src.indexOf('trap gate_guard EXIT')
    const step9 = src.indexOf('step 9 ')
    const dockerCp = src.indexOf('docker cp "${cf_cid}')
    const enableUpdate = src.lastIndexOf('    systemctl enable --now fju-status-update.timer')
    expect(src.slice(src.indexOf('step 8 '), step9)).not.toMatch(/run systemctl enable --now fju-status-update/)
    expect(guard).toBeGreaterThan(0)
    expect(guard).toBeLessThan(step9)
    expect(enableUpdate).toBeGreaterThan(dockerCp)
    const shut = src.slice(src.indexOf('shut_gate() {'), src.indexOf('gate_guard() {'))
    expect(shut).toContain('systemctl disable --now fju-status-update.timer')
    expect(shut).toContain('systemctl stop fju-status-update.service')
    expect(shut).toMatch(/for cid in \$\(svc_cids cloudflared\)/)
  })
})

describe('status-prepare.sh --dry-run 只印不做', () => {
  it('不產金鑰、不連 VM；印兩支重置腳本 sha256 與要貼的那一行', () => {
    const r = run(PREPARE, ['--dry-run', '--access-team', TEAM, '--access-aud', AUD])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('會執行：ssh-keygen')
    expect(r.stdout).toContain('會執行：rsync')
    expect(r.stdout).toMatch(/[0-9a-f]{64} {2}fju-test-reset\n/)
    expect(r.stdout).toMatch(/[0-9a-f]{64} {2}fju-test-reset-gate\n/)
    expect(r.stdout).toContain(`sudo bash /srv/fju/app/ops/status-install.sh --access-team ${TEAM} --access-aud ${AUD} --publish-pubkey '`)
    expect(fs.existsSync(path.join(dir, '.ssh', 'fju_status_publish'))).toBe(false)
    expect(mutatingCalls()).toEqual([])
  })

  it('已有金鑰：沿用，貼的那一行帶這把公鑰', () => {
    fs.mkdirSync(path.join(dir, '.ssh'))
    fs.writeFileSync(path.join(dir, '.ssh', 'fju_status_publish'), 'private')
    fs.writeFileSync(path.join(dir, '.ssh', 'fju_status_publish.pub'), `${PUBKEY}\n`)
    const r = run(PREPARE, ['--dry-run', '--access-team', TEAM, '--access-aud', AUD])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(`--publish-pubkey '${PUBKEY}'`)
    expect(mutatingCalls()).toEqual([])
  })
})
