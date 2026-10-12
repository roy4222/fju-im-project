import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * S-9：ops/status-install.sh（VM，sudo 一次）與 ops/status-prepare.sh（Mac mini）。
 *
 * 全部在本機跑、不需要 root：
 * - `bash -n`、`--help`、`--dry-run`、`--check-cloudflared-config`：會改系統的指令換成只記錄呼叫的假指令，
 *   用來證明 --dry-run 一個都沒叫。對應 AC-S-14（記憶體不足就停）、AC-S-25(b)（第 10 步第二段的檢查）。
 * - 故障注入（最後一組）：真的跑非 dry-run 的整個流程，系統路徑用 FJU_STATUS_* 換成暫存目錄，
 *   docker／systemctl／curl／runuser 換成會模擬 VM 狀態的假指令，Cloudflare DNS API 換成本機假伺服器。
 */

const repoRoot = path.join(import.meta.dirname, '..', '..', '..')
const INSTALL = path.join(repoRoot, 'ops', 'status-install.sh')
const PREPARE = path.join(repoRoot, 'ops', 'status-prepare.sh')
// main 上 S-4 的真產生器（JSON 寫法的 YAML）；整個假 VM 流程與檢查器整合測試都用它的真輸出。
const RENDER = path.join(repoRoot, 'ops', 'status-render-cloudflared.sh')
const TUNNEL_ID = '11111111-1111-1111-1111-111111111111'
const VERIFY_TUNNEL_ID = '22222222-2222-2222-2222-222222222222'
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
      NODE_ENV: 'test',
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
  it.each([INSTALL, PREPARE])('bash -n %s', (script: string) => {
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
    expect(r.stdout).toContain('--keep-site-compose')
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

  it('整合：實際呼叫 main 上 S-4 的產生器（JSON 寫法的 YAML）→ 同一個檢查器通過；--no-access 的不通過；鍵寫兩次判失敗', () => {
    const out = path.join(dir, 'rendered.yml')
    const r0 = spawnSync('bash', [RENDER, '--team', TEAM, '--aud', AUD, '--tunnel-id', TUNNEL_ID, '--out', out], { encoding: 'utf8' })
    expect(r0.status).toBe(0)
    const body = fs.readFileSync(out, 'utf8')
    expect(body.trimStart().startsWith('{')).toBe(true)
    const ok = check(out)
    expect(ok.out).toContain('每條 ingress 都有 originRequest.access')
    expect(ok.code).toBe(0)

    const open = path.join(dir, 'rendered-open.yml')
    expect(spawnSync('bash', [RENDER, '--team', TEAM, '--aud', AUD, '--tunnel-id', TUNNEL_ID, '--out', open, '--no-access'], { encoding: 'utf8' }).status).toBe(0)
    const bad = check(open)
    expect(bad.code).not.toBe(0)
    for (const h of HOSTS) expect(bad.out).toContain(`✗ ${h}：`)

    const dup = check(writeConfig('rendered-dup.yml', body.replace('"required": true', '"required": true, "required": false')))
    expect(dup.code).not.toBe(0)
    expect(dup.out).toContain('同一個鍵寫了兩次')

    const wrongAud = check(writeConfig('rendered-aud.yml', body.replaceAll(AUD, 'f'.repeat(64))))
    expect(wrongAud.code).not.toBe(0)
    expect(wrongAud.out).toContain('audTag 不是恰好這一個 AUD')
  })

  it('JSON 字串值裡塞換行假裝 access 路徑（四條其實都沒有 access）：判失敗', () => {
    const open = path.join(dir, 'open.json')
    expect(spawnSync('bash', [RENDER, '--team', TEAM, '--aud', AUD, '--tunnel-id', TUNNEL_ID, '--out', open, '--no-access'], { encoding: 'utf8' }).status).toBe(0)
    const doc = JSON.parse(fs.readFileSync(open, 'utf8')) as { ingress: Array<Record<string, unknown>> }
    doc.ingress.forEach((e, i) => {
      if (typeof e.service === 'string' && !e.service.startsWith('http_status:')) {
        e.service = `${e.service}\ningress.${i}.originRequest.access.required=true\ningress.${i}.originRequest.access.teamName=royteam\ningress.${i}.originRequest.access.audTag.0=${AUD}`
      }
    })
    const r = check(writeConfig('newline-inject.json', JSON.stringify(doc, null, 2)))
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('值裡有換行')
    for (const h of HOSTS) expect(r.out).toContain(`✗ ${h}：access.required 不是 true`)
  })

  it('區塊 YAML：純量值底下再縮排（接續行、| 區塊純量）假裝 access：判看不懂', () => {
    const inject = (serviceLine: string) =>
      ['tunnel: x', 'ingress:', ...HOSTS.map((h) => [`  - hostname: ${h}`, serviceLine, '      originRequest:', '        access:', '          required: true', '          teamName: royteam', '          audTag:', `            - ${AUD}`].join('\n')), '  - service: http_status:404', ''].join('\n')
    const cont = check(writeConfig('yaml-cont.yml', inject('    service: http://status-web:3000')))
    expect(cont.code).not.toBe(0)
    expect(cont.out).toContain('看不懂的寫法')
    const block = check(writeConfig('yaml-block.yml', inject('    service: |')))
    expect(block.code).not.toBe(0)
    expect(block.out).toContain('看不懂的寫法')
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
})

describe('status-prepare.sh --dry-run 只印不做', () => {
  // 第 5 步（同步／搬遷）要依這個順序印；第 6 步（安裝）在最後。
  const ORDER = [
    'B1 暫停自動部署',
    'B2 記下目前版本',
    'sudo cp -a /srv/fju/app',
    'sudo diff -r /srv/fju/app',
    "sudo rsync -a --delete --filter='P /ops/status/cloudflared.yml' --chown=deploy:deploy /tmp/fju-app/ /srv/fju/app/",
    'absent／false 就停',
    'status-envcheck.sh test',
    'vm-setup.sh --check',
    '5-6 C1a',
    'C1b',
    'C3',
    '5-7 D ',
    '5-8 E ',
    'sudo bash /srv/fju/app/ops/status-install.sh --access-team',
  ]
  function at(out: string, needle: string): number {
    const i = out.indexOf(needle)
    expect(i, `找不到「${needle}」`).toBeGreaterThanOrEqual(0)
    return i
  }

  it('不產金鑰、不連 VM；印兩支重置腳本 sha256、rsync 預檢與安裝那一行', () => {
    const r = run(PREPARE, ['--dry-run', '--access-team', TEAM, '--access-aud', AUD])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('會執行：ssh-keygen')
    expect(r.stdout).toContain('會執行：rsync')
    expect(r.stdout).toMatch(/[0-9a-f]{64} {2}fju-test-reset\n/)
    expect(r.stdout).toMatch(/[0-9a-f]{64} {2}fju-test-reset-gate\n/)
    expect(r.stdout).toContain("rsync -n -ai --delete --filter='P /ops/status/cloudflared.yml' /tmp/fju-app/ /srv/fju/app/")
    expect(r.stdout).toContain(`sudo bash /srv/fju/app/ops/status-install.sh --access-team ${TEAM} --access-aud ${AUD} --publish-pubkey '`)
    expect(fs.existsSync(path.join(dir, '.ssh', 'fju_status_publish'))).toBe(false)
    expect(mutatingCalls()).toEqual([])
  })

  it('預設：同步與安裝分成兩段，不印「rsync && sudo bash status-install」合併行；安裝行在搬遷清單之後', () => {
    const r = run(PREPARE, ['--dry-run', '--access-team', TEAM, '--access-aud', AUD])
    expect(r.code).toBe(0)
    expect(r.stdout).not.toContain('/srv/fju/app/ && sudo bash')
    expect(r.stdout).not.toContain("--exclude='/docker-compose")
    let prev = -1
    for (const needle of ORDER) {
      const i = at(r.stdout, needle)
      expect(i, `「${needle}」要在前一項之後`).toBeGreaterThan(prev)
      prev = i
    }
    expect(r.stdout).toContain('6. 安裝開發者後台')
  })

  it('預設：備份核對不過就不同步；同步不一致就印還原；Doppler 探針是搬遷第一道關卡', () => {
    const r = run(PREPARE, ['--dry-run', '--access-team', TEAM, '--access-aud', AUD])
    expect(r.code).toBe(0)
    // 備份→diff→（✓）→rsync→diff：一條 && 鏈（反斜線接行＝一個指令），任一步失敗走 || 印「停在…」與還原指令
    expect(r.stdout).toContain('BAK=/srv/fju/app.bak-$(date +%Y%m%d-%H%M%S) \\\n&& { sudo cp -a /srv/fju/app "$BAK" && sudo diff -r /srv/fju/app "$BAK" && echo "✓ 備份完整')
    expect(r.stdout).toContain('✗ 停在備份')
    expect(r.stdout).toContain('; false; }; } \\\n&& { sudo rsync -a --delete')
    expect(r.stdout).toMatch(/\/srv\/fju\/app\/ && sudo diff -r --exclude=cloudflared\.yml \/tmp\/fju-app \/srv\/fju\/app && echo "✓ 已同步/)
    expect(r.stdout).toContain('✗ 停在同步：還原 → sudo rsync -a --delete ${BAK:?}/ /srv/fju/app/')
    // 探針在 rsync 之後、vm-setup 之前；印 absent／false 就停並給還原
    const rsyncAt = at(r.stdout, '--chown=deploy:deploy /tmp/fju-app/ /srv/fju/app/ && sudo diff')
    const probeAt = at(r.stdout, 'sudo -u deploy /srv/fju/app/ops/status-envcheck.sh test --out /tmp/envcheck-test.json')
    const setupAt = at(r.stdout, 'vm-setup.sh --check')
    expect(probeAt).toBeGreaterThan(rsyncAt)
    expect(setupAt).toBeGreaterThan(probeAt)
    expect(r.stdout).toContain('REGISTRATION_OPEN：other 才往下')
    expect(r.stdout).toContain('sudo cp -a "${BAK:?}/docker-compose.vm.yml" "${BAK:?}/docker-compose.edge.yml" /srv/fju/app/ && sudo -u deploy rm /srv/fju/test/deploy/auto-deploy.paused')
    expect(mutatingCalls()).toEqual([])
  })

  it('--keep-site-compose：rsync 多兩個 exclude、備份核對仍在、接著恢復自動部署、不印搬遷清單；安裝行在後', () => {
    const r = run(PREPARE, ['--dry-run', '--keep-site-compose', '--access-team', TEAM, '--access-aud', AUD])
    expect(r.code).toBe(0)
    const rsyncLine = "sudo rsync -a --delete --filter='P /ops/status/cloudflared.yml' --exclude='/docker-compose.vm.yml' --exclude='/docker-compose.edge.yml' --chown=deploy:deploy /tmp/fju-app/ /srv/fju/app/"
    expect(r.stdout).toContain(rsyncLine)
    expect(r.stdout).toContain('--exclude=docker-compose.vm.yml --exclude=docker-compose.edge.yml /tmp/fju-app /srv/fju/app')
    expect(r.stdout).not.toContain('/srv/fju/app/ && sudo bash')
    expect(r.stdout).not.toContain('C1a')
    expect(r.stdout).not.toContain('status-envcheck.sh test')
    const cpAt = at(r.stdout, 'sudo cp -a /srv/fju/app')
    const rsyncAt = at(r.stdout, rsyncLine)
    const resumeAt = at(r.stdout, 'sudo -u deploy rm /srv/fju/test/deploy/auto-deploy.paused')
    const installAt = at(r.stdout, 'sudo bash /srv/fju/app/ops/status-install.sh --access-team')
    expect(rsyncAt).toBeGreaterThan(cpAt)
    expect(resumeAt).toBeGreaterThan(rsyncAt)
    expect(installAt).toBeGreaterThan(resumeAt)
    expect(r.stdout).toContain('不會被換')
    expect(mutatingCalls()).toEqual([])
  })

  it('已有金鑰：沿用，安裝那一行帶這把公鑰', () => {
    fs.mkdirSync(path.join(dir, '.ssh'))
    fs.writeFileSync(path.join(dir, '.ssh', 'fju_status_publish'), 'private')
    fs.writeFileSync(path.join(dir, '.ssh', 'fju_status_publish.pub'), `${PUBKEY}\n`)
    const r = run(PREPARE, ['--dry-run', '--access-team', TEAM, '--access-aud', AUD])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(`--publish-pubkey '${PUBKEY}'`)
    expect(mutatingCalls()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 故障注入：prepare 第 5-3 印給 Roy 貼的「備份→核對→同步→核對」那條 && 鏈。
// 路徑換成暫存目錄、sudo 換成直接執行（或依 FAKE_FAIL／FAKE_NOOP 模擬失敗），真的跑 cp／diff／rsync／find。
// 舊版（備份失敗照樣 rsync --delete）在「備份失敗」與「同步後不一致」兩案會紅。
describe('prepare 第 5-3 同步鏈：任一步失敗就停、不往下寫、印還原', () => {
  let sbin: string
  let src: string
  let app: string

  function syncBlock() {
    const r = run(PREPARE, ['--dry-run', '--access-team', TEAM, '--access-aud', AUD])
    expect(r.code).toBe(0)
    const lines = r.stdout.split('\n')
    const start = lines.findIndex((l) => l.startsWith('BAK=/srv/fju/app.bak-'))
    expect(start).toBeGreaterThan(0)
    let end = start
    while (lines[end] !== '') end++
    return lines.slice(start, end).join('\n')
      .replaceAll('/srv/fju/app', app)
      .replaceAll('/tmp/fju-app', src)
      .replaceAll(' --chown=deploy:deploy', '') // 本機不是 root，chown 會讓 rsync 回 23
  }

  function runSync(env: Record<string, string> = {}) {
    const r = spawnSync('bash', ['-c', syncBlock()], {
      encoding: 'utf8',
      env: { NODE_ENV: 'test', PATH: `${sbin}:${process.env.PATH}`, HOME: dir, CALLS_LOG: callsLog, LANG: 'C.UTF-8', ...env },
    })
    return { code: r.status, stdout: r.stdout, out: `${r.stdout}${r.stderr}` }
  }

  const tree = (root: string) => {
    const out: string[] = []
    const walk = (d: string, rel: string) => {
      for (const n of fs.readdirSync(d).sort()) {
        const p = path.join(d, n)
        const r = rel ? `${rel}/${n}` : n
        if (fs.statSync(p).isDirectory()) walk(p, r)
        else out.push(`${r}=${fs.readFileSync(p, 'utf8')}`)
      }
    }
    walk(root, '')
    return out
  }

  beforeEach(() => {
    sbin = path.join(dir, 'sbin')
    fs.mkdirSync(sbin)
    fs.writeFileSync(path.join(sbin, 'sudo'), [
      '#!/bin/sh',
      'echo "sudo $*" >> "$CALLS_LOG"',
      'case " $* " in *" ${FAKE_FAIL:-__none__} "*) exit 1 ;; esac',
      '[ "${FAKE_NOOP:-}" = "$1" ] && exit 0',
      'exec "$@"',
      '',
    ].join('\n'))
    fs.chmodSync(path.join(sbin, 'sudo'), 0o755)
    src = path.join(dir, 'fju-app')
    app = path.join(dir, 'srv', 'app')
    fs.mkdirSync(path.join(src, 'ops', 'status'), { recursive: true })
    fs.mkdirSync(path.join(app, 'ops', 'status'), { recursive: true })
    // VM 現況：舊 compose、一個 repo 沒有的檔不存在、後台產生的 cloudflared.yml 在
    fs.writeFileSync(path.join(app, 'docker-compose.vm.yml'), 'old-vm\n')
    // 跟 VM 一樣：舊檔 mtime 是 09-26（同大小同時間 rsync 會當成沒變）
    fs.utimesSync(path.join(app, 'docker-compose.vm.yml'), new Date('2026-09-26T02:36:00Z'), new Date('2026-09-26T02:36:00Z'))
    fs.writeFileSync(path.join(app, 'ops', 'deploy.sh'), 'same\n')
    fs.writeFileSync(path.join(app, 'ops', 'status', 'cloudflared.yml'), 'generated-on-vm\n')
    // Mac 送來的：新 compose、新檔、同檔
    fs.writeFileSync(path.join(src, 'docker-compose.vm.yml'), 'new-vm\n')
    fs.writeFileSync(path.join(src, 'docker-compose.status.yml'), 'status\n')
    fs.writeFileSync(path.join(src, 'ops', 'deploy.sh'), 'same\n')
    fs.writeFileSync(path.join(src, 'ops', 'status', 'gatus.yml'), 'gatus\n')
  })

  it('正常：備份核對 ✓、同步後與來源一致 ✓、cloudflared.yml 留著、結束碼 0', () => {
    const before = tree(app)
    const r = runSync()
    expect(r.out).toContain('✓ 備份完整：')
    expect(r.out).toContain('✓ 已同步：')
    expect(r.code).toBe(0)
    const baks = fs.readdirSync(path.join(dir, 'srv')).filter((n) => n.startsWith('app.bak-'))
    expect(baks).toHaveLength(1)
    expect(tree(path.join(dir, 'srv', baks[0] ?? ''))).toEqual(before)
    expect(tree(app)).toEqual([
      'docker-compose.status.yml=status\n',
      'docker-compose.vm.yml=new-vm\n',
      'ops/deploy.sh=same\n',
      'ops/status/cloudflared.yml=generated-on-vm\n',
      'ops/status/gatus.yml=gatus\n',
    ])
  })

  it('備份失敗：印「✗ 停在備份」、rsync 一次都沒跑、/srv/fju/app 原封不動、結束碼非 0', () => {
    const before = tree(app)
    const r = runSync({ FAKE_FAIL: 'cp' })
    expect(r.out).toContain('✗ 停在備份：')
    expect(r.out).not.toContain('✓ 已同步')
    expect(r.code).not.toBe(0)
    expect(calls().filter((c) => c.startsWith('sudo rsync'))).toEqual([])
    expect(tree(app)).toEqual(before)
  })

  it('同步後不一致（rsync 沒真的寫）：印「✗ 停在同步」與帶實際備份路徑的還原指令、結束碼非 0', () => {
    const r = runSync({ FAKE_NOOP: 'rsync' })
    expect(r.out).toContain('✓ 備份完整：')
    expect(r.out).toMatch(new RegExp(`✗ 停在同步：還原 → sudo rsync -a --delete ${app.replace(/[/.]/g, '\\$&')}\\.bak-\\d{8}-\\d{6}/ ${app.replace(/[/.]/g, '\\$&')}/`))
    expect(r.code).not.toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 故障注入：ops/README.md 兩站網路拆分 D 框（最終版 Caddy）。整段從 README 抽出來跑，
// docker／curl／sudo 換成依 FAKE_* 模擬 VM 狀態的假指令。
// 舊版（重建完不看結果就刪過渡設定、恢復自動部署、curl 502 也 exit 0）在前三案都會紅。
describe('README T4 D 框：Caddy 接對兩個網路且測試站 200 才清理、才恢復自動部署', () => {
  let dbin: string
  let script: string

  beforeEach(() => {
    const readme = fs.readFileSync(path.join(repoRoot, 'ops', 'README.md'), 'utf8')
    const head = readme.indexOf('**D. 🖥️ VM 🔑：Caddy 最終版')
    expect(head).toBeGreaterThan(0)
    const open = readme.indexOf('```bash\n', head) + '```bash\n'.length
    const close = readme.indexOf('```', open)
    script = path.join(dir, 'd-block.sh')
    fs.writeFileSync(script, `cd() { :; }\n${readme.slice(open, close)}`)
    dbin = path.join(dir, 'dbin')
    fs.mkdirSync(dbin)
    const shims: Record<string, string> = {
      sudo: 'echo "sudo $*" >> "$CALLS_LOG"\ncase "$*" in *"docker compose"*) exit "${FAKE_COMPOSE_RC:-0}" ;; *vm-setup.sh*) exit "${FAKE_SETUP_RC:-0}" ;; esac\nexit 0',
      docker: 'echo "docker $*" >> "$CALLS_LOG"\nprintf \'%s \' $FAKE_NETS',
      curl: 'echo "curl $*" >> "$CALLS_LOG"\nprintf \'%s\' "${FAKE_CODE:-502}"',
      rm: 'echo "rm $*" >> "$CALLS_LOG"',
      sleep: 'exit 0',
    }
    for (const [name, body] of Object.entries(shims)) {
      fs.writeFileSync(path.join(dbin, name), `#!/bin/sh\n${body}\n`)
      fs.chmodSync(path.join(dbin, name), 0o755)
    }
  })

  function runD(env: Record<string, string>) {
    const r = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: { NODE_ENV: 'test', PATH: `${dbin}:${process.env.PATH}`, HOME: dir, CALLS_LOG: callsLog, LANG: 'C.UTF-8', ...env },
    })
    return { code: r.status, out: `${r.stdout}${r.stderr}` }
  }
  const cleaned = () => calls().some((c) => c === 'rm -f /tmp/fju-edge-transition.yml')
  const resumed = () => calls().some((c) => c === 'sudo -u deploy rm /srv/fju/test/deploy/auto-deploy.paused')
  const setupRan = () => calls().some((c) => c.includes('vm-setup.sh'))
  const GOOD = { FAKE_NETS: 'fju-edge-prod fju-edge-test', FAKE_CODE: '200' }

  it('全部符合：刪過渡設定、跑 vm-setup、恢復自動部署、印 ✓ D 完成、結束碼 0', () => {
    const r = runD(GOOD)
    expect(r.out).toContain('✓ D 完成')
    expect(r.code).toBe(0)
    expect(cleaned()).toBe(true)
    expect(setupRan()).toBe(true)
    expect(resumed()).toBe(true)
  })

  it('測試站一直 502：過渡設定留著、不跑 vm-setup、不恢復自動部署、印回到過渡版的指令、結束碼非 0', () => {
    const r = runD({ ...GOOD, FAKE_CODE: '502' })
    expect(r.out).toContain('對外 /api/health：502')
    expect(r.out).toContain('-f /tmp/fju-edge-transition.yml up -d')
    expect(r.code).not.toBe(0)
    expect(cleaned()).toBe(false)
    expect(setupRan()).toBe(false)
    expect(resumed()).toBe(false)
  })

  it('Caddy 還掛著舊網路：同上，不清理、不恢復、結束碼非 0', () => {
    const r = runD({ ...GOOD, FAKE_NETS: 'fju-edge fju-edge-prod fju-edge-test' })
    expect(r.out).toContain('Caddy 網路：「fju-edge fju-edge-prod fju-edge-test」')
    expect(r.code).not.toBe(0)
    expect(cleaned()).toBe(false)
    expect(resumed()).toBe(false)
  })

  it('compose up 失敗（或 120 秒逾時）：不清理、不恢復、結束碼非 0', () => {
    const r = runD({ ...GOOD, FAKE_COMPOSE_RC: '124' })
    expect(r.out).toContain('Caddy up：exit 124')
    expect(r.code).not.toBe(0)
    expect(cleaned()).toBe(false)
    expect(resumed()).toBe(false)
  })

  it('Caddy 好了但 vm-setup 失敗：自動部署維持暫停、印修好後重跑的指令、結束碼非 0', () => {
    const r = runD({ ...GOOD, FAKE_SETUP_RC: '1' })
    expect(r.out).toContain('修好後重跑')
    expect(r.code).not.toBe(0)
    expect(cleaned()).toBe(true)
    expect(resumed()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 故障注入：真的跑非 dry-run 的安裝流程（假 VM）
// ---------------------------------------------------------------------------

const CF_IMAGE = 'cloudflare/cloudflared:2025.9.1'
// 下面幾支假指令是 bash：模板字串裡的 bash 變數寫成 @{…}，這裡換回 ${…}（避免被當成 JS 插值）。
const bash = (src: string) => src.replaceAll('@{', '${')

// 假 docker：用 $FAKE_STATE 底下的檔案記住容器、網路、隧道、暫時 cloudflared 有沒有鎖、假 origin 的計數。
const FAKE_DOCKER = bash(String.raw`#!/bin/bash
S=$FAKE_STATE
echo "docker $*" >> "$CALLS_LOG"
drop() { grep -vx "$2" "$S/$1" > "$S/$1.tmp" || true; mv "$S/$1.tmp" "$S/$1"; }
case "$1" in
  compose|stats|pull|exec)
    [ "$1" = exec ] && echo fjudb
    exit 0 ;;
  stop)
    # FAKE_STOP_FAIL=1：docker stop 一律失敗。
    [ "@{FAKE_STOP_FAIL:-0}" = 1 ] && exit 1
    exit 0 ;;
  ps)
    if [ "$2" = -a ]; then cat "$S/containers"; exit 0; fi
    svc=$(printf '%s\n' "$@" | sed -n 's/^label=com.docker.compose.service=//p')
    if [ "$svc" = cloudflared ]; then
      # FAKE_PS_FAIL=1：列舉一律失敗（docker 回非 0、沒輸出）。
      [ "@{FAKE_PS_FAIL:-0}" = 1 ] && exit 1
      # FAKE_PS_SLOW=1：模擬真 Docker CLI（Go）：就算繼承了忽略，收到 INT／TERM 還是會中斷（signal.NotifyContext）。
      # 列舉時留 ps-running 給測試看、等測試放 ps-go 才印容器 id；中途被訊號殺掉就回非 0。
      if [ "@{FAKE_PS_SLOW:-0}" = 1 ]; then
        exec python3 - "$S" "cid-$svc" <<'PY'
import os, signal, sys, time
s, cid = sys.argv[1], sys.argv[2]
for sg in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
    signal.signal(sg, signal.SIG_DFL)
open(os.path.join(s, "ps-running"), "w").close()
while not os.path.exists(os.path.join(s, "ps-go")):
    time.sleep(0.05)
print(cid)
PY
      fi
    fi
    echo "cid-$svc"; exit 0 ;;
  inspect)
    case "$*" in *State.Running*) echo true ;; *State.Health*) echo healthy ;; esac
    exit 0 ;;
  cp)
    case "$2" in
      cid-cloudflared:*) tar -cf - -C "$(dirname "$FAKE_MOUNTED")" "$(basename "$FAKE_MOUNTED")" ;;
      cid-beszel:*) tar -cf - -C "$S" hubkey ;;
    esac
    exit 0 ;;
  rm)
    shift; [ "$1" = -f ] && shift
    for n in "$@"; do
      drop containers "$n"
      [ "$n" = fju-status-verify-cloudflared ] && echo none > "$S/cf_mode"
    done
    exit 0 ;;
  network)
    case "$2" in
      create) echo "$3" >> "$S/networks" ;;
      rm) [ "@{FAKE_NETRM_FAIL:-0}" = 1 ] && exit 1; drop networks "$3" ;;
      ls) cat "$S/networks" ;;
    esac
    exit 0 ;;
  run)
    shift
    name=""; detach=0; login=""; cfg=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --rm) ;;
        -d) detach=1 ;;
        --name) name=$2; shift ;;
        -v) case "$2" in
              *:/cf/.cloudflared) login=@{2%:/cf/.cloudflared} ;;
              *:/etc/cloudflared/config.yml:ro) cfg=@{2%:/etc/cloudflared/config.yml:ro} ;;
            esac; shift ;;
        --network|--network-alias|--memory|--user|-e|--pull) shift ;;
        *) break ;;
      esac
      shift
    done
    image=$1; shift
    [ -n "$name" ] && echo "$name" >> "$S/containers"
    case "$image" in
      curlimages/*) cat "$S/counter"; exit 0 ;;
      ghcr.io/*) echo 0 > "$S/counter"; exit 0 ;;
      cloudflare/*)
        [ "$1" = tunnel ] && shift
        if [ "$detach" = 1 ]; then
          if grep -q '"access"\|access:' "$cfg"; then echo locked > "$S/cf_mode"; else echo open > "$S/cf_mode"; fi
          exit 0
        fi
        sub=$1; shift
        last=""; cred=""; n=""
        while [ $# -gt 0 ]; do
          case "$1" in
            --credentials-file|--cred-file) cred=$2; shift ;;
            --name) n=$2; shift ;;
            --output|-f) [ "$1" = --output ] && shift ;;
            *) last=$1 ;;
          esac
          shift
        done
        case "$sub" in
          login)
            # FAKE_LOGIN_BLOCK=1：模擬「印出授權網址後等 Roy 點」——先留 login-waiting 給測試看，
            # 再等測試放 login-go（內容 fail 就當授權失敗）。注意 sleep 被換成假的，要用 /bin/sleep。
            if [ "@{FAKE_LOGIN_BLOCK:-0}" = 1 ]; then
              echo "https://dash.cloudflare.com/argotunnel?fake"
              : > "$S/login-waiting"
              while [ ! -e "$S/login-go" ]; do /bin/sleep 0.05; done
              [ "$(cat "$S/login-go")" = fail ] && exit 1
            fi
            tok=$(printf '{"zoneID":"z1","accountID":"a1","apiToken":"t1"}' | base64 | tr -d '\n')
            printf -- '-----BEGIN ARGO TUNNEL TOKEN-----\n%s\n-----END ARGO TUNNEL TOKEN-----\n' "$tok" > "$login/cert.pem"
            echo login >> "$S/logins" ;;
          list)
            if [ -f "$S/tunnel-$n" ]; then printf '[{"id":"id-%s","name":"%s"}]' "$n" "$n"; else echo '[]'; fi ;;
          create|token)
            touch "$S/tunnel-$last"
            case "$last" in fju-status) tid=@{FAKE_TUNNEL_ID} ;; *) tid=@{FAKE_VERIFY_TUNNEL_ID} ;; esac
            printf '{"TunnelID":"%s"}' "$tid" > "$login/$(basename "$cred")" ;;
          delete) rm -f "$S/tunnel-$last" ;;
        esac
        exit 0 ;;
    esac
    exit 0 ;;
esac
exit 0
`)

// 假 curl：暫時網址照暫時 cloudflared 有沒有鎖回 403／404／204（沒鎖時 /probe 會讓假 origin 計數加一）；
// 四個正式網址都回 Access 的 302。
const FAKE_CURL = bash(String.raw`#!/bin/bash
echo "curl $*" >> "$CALLS_LOG"
url=@{@: -1}
mode=$(cat "$FAKE_STATE/cf_mode" 2>/dev/null)
case "$url" in
  https://fju-status-verify.roy422.dev/ready)
    case "$mode" in locked) printf 403 ;; open) printf 404 ;; *) printf 000 ;; esac ;;
  https://fju-status-verify.roy422.dev/probe)
    case "$mode" in
      locked) printf 403 ;;
      open) c=$(cat "$FAKE_STATE/counter"); echo $((c + 1)) > "$FAKE_STATE/counter"; printf 204 ;;
      *) printf 000 ;;
    esac ;;
  https://*/)
    h=@{url#https://}; h=@{h%/}
    # FAKE_UNGUARDED=<網址>：那個網址沒被 Access 擋（回 200），第 10 步守門要失敗、關門。
    if [ "$h" = "@{FAKE_UNGUARDED:-}" ]; then printf '200 '; else printf '302 https://%s/cdn-cgi/access/login/%s' "$FAKE_TEAM" "$h"; fi ;;
esac
`)

const FAKE_SIMPLE: Record<string, string> = {
  id: `#!/bin/sh\n[ "$1" = -u ] && echo 0\nexit 0\n`,
  // FAKE_DOOR_BLOCK=1：關門的第一個動作（disable --now update timer，只有關門會叫）卡住，留 door-closing 給測試看，
  // 等測試放 door-go 才回來；給「關門途中送訊號」用。sleep 被換成假的，要用 /bin/sleep。
  // FAKE_SYSTEMCTL_FAIL=1：凡是碰 fju-status-update 的指令（stop、disable、show、is-*）都失敗、沒輸出——關門時讀不到狀態。
  // show：關門時用來確認明確狀態（LoadState／ActiveState／UnitFileState）。
  systemctl: `#!/bin/sh\necho "systemctl $*" >> "$CALLS_LOG"\nif [ "\${FAKE_SYSTEMCTL_FAIL:-0}" = 1 ]; then case "$*" in *fju-status-update*) exit 1 ;; esac; fi\ncase "$1" in is-*) exit 1 ;; show) printf 'LoadState=loaded\\nActiveState=inactive\\nUnitFileState=disabled\\n'; exit 0 ;; esac\nif [ "\${FAKE_DOOR_BLOCK:-0}" = 1 ] && [ "$1" = disable ]; then : > "$FAKE_STATE/door-closing"; while [ ! -e "$FAKE_STATE/door-go" ]; do /bin/sleep 0.05; done; fi\nexit 0\n`,
  runuser: `#!/bin/sh\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n`,
  // FAKE_INSTALL_FAIL=1：裝 systemd 的 .timer 檔時回 1（第 8 步一個沒接 || halt 的普通指令失敗 → set -e 直接中止）。
  install: `#!/bin/sh\nif [ "\${FAKE_INSTALL_FAIL:-0}" = 1 ]; then case "$*" in *.timer*) echo "install: 假裝失敗" >&2; exit 1 ;; esac; fi\nargs=""\nwhile [ $# -gt 0 ]; do case "$1" in -o|-g) shift ;; *) args="$args '$1'" ;; esac; shift; done\neval exec /usr/bin/install $args\n`,
  chown: `#!/bin/sh\nexit 0\n`,
  useradd: `#!/bin/sh\necho "useradd $*" >> "$CALLS_LOG"\n`,
  sshd: `#!/bin/sh\nexit 0\n`,
  'ssh-keygen': `#!/bin/sh\necho "ssh-ed25519 AAAAFakeHubKey beszel"\n`,
  sleep: `#!/bin/sh\nexit 0\n`,
}

// 產生器：直接包 main 上 S-4 的真產生器（整個流程用的就是真輸出，JSON 寫法的 YAML）。
// FAKE_RENDER_BAD=1：加 --no-access（壞設定，第 7 步要擋下、關門）。
const FAKE_RENDER = bash(String.raw`#!/bin/bash
extra=""
[ "@{FAKE_RENDER_BAD:-0}" = 1 ] && extra="--no-access"
exec bash "$FAKE_REAL_RENDER" "$@" $extra
`)

// 假 status-up.sh：記下呼叫；FAKE_UP_FAIL=1 時，beszel-agent.env 已有金鑰的那次（第 11 步重起 agent）回 42。
const FAKE_UP = bash(String.raw`#!/bin/bash
echo "status-up $*" >> "$CALLS_LOG"
if [ "@{FAKE_UP_FAIL:-0}" = 1 ] && [ $# -eq 0 ] && grep -q '^KEY=' "$FJU_STATUS_ROOT/secrets/beszel-agent.env" 2>/dev/null; then exit 42; fi
exit 0
`)

type Vm = {
  w: string
  root: string
  state: string
  calls: string
  dns: { records: number; failDelete: boolean; deletes: number }
  server: http.Server
  port: number
}

async function makeVm(): Promise<Vm> {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'fju-status-vm-'))
  const mk = (...p: string[]) => fs.mkdirSync(path.join(w, ...p), { recursive: true })
  const put = (rel: string, body: string, mode = 0o644) => {
    fs.mkdirSync(path.dirname(path.join(w, rel)), { recursive: true })
    fs.writeFileSync(path.join(w, rel), body, { mode })
  }
  for (const [name, body] of Object.entries(FAKE_SIMPLE)) put(`bin/${name}`, body, 0o755)
  put('bin/docker', FAKE_DOCKER, 0o755)
  put('bin/curl', FAKE_CURL, 0o755)
  put('app/docker-compose.status.yml', `services:\n  cloudflared:\n    image: ${CF_IMAGE}\n  status-web:\n    image: ghcr.io/roy4222/fju-status:main\n`)
  put('app/ops/status-up.sh', FAKE_UP, 0o755)
  put('app/ops/status-render-cloudflared.sh', FAKE_RENDER, 0o755)
  for (const u of ['fju-status-update.service', 'fju-status-update.timer', 'fju-status-envcheck.service', 'fju-status-envcheck.timer']) {
    put(`app/ops/status/systemd/${u}`, `[Unit]\nDescription=${u}\n`)
  }
  put('os-release', 'ID=ubuntu\nVERSION_ID="24.04"\n')
  put('rrsync', '#!/bin/sh\n', 0o755)
  // 第 10 步 docker cp 取出的「實際掛載」設定：用真產生器產（main 的 S-4）。
  mk('mounted')
  const rendered = spawnSync('bash', [RENDER, '--team', TEAM, '--aud', AUD, '--tunnel-id', TUNNEL_ID, '--out', path.join(w, 'mounted', 'config.yml')], { encoding: 'utf8' })
  if (rendered.status !== 0) throw new Error(`產生器失敗：${rendered.stdout}${rendered.stderr}`)
  put('state/hubkey', 'fake private key\n')
  for (const f of ['containers', 'networks', 'logins']) put(`state/${f}`, '')
  put('state/counter', '0\n')
  put('calls.log', '')
  mk('root'); mk('units'); mk('ssh'); mk('home'); mk('sbin'); mk('offsite')

  // 假 Cloudflare DNS API：一開始有一筆暫時網址的 CNAME；failDelete 時 DELETE 回 403。
  const dns = { records: 1, failDelete: false, deletes: 0 }
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.method === 'DELETE') {
      if (dns.failDelete) { res.statusCode = 403; res.end('{"success":false}'); return }
      dns.deletes++; dns.records = 0; res.end('{"success":true}'); return
    }
    const rec = { id: 'r1', name: 'fju-status-verify.roy422.dev', content: 'id-fju-status-verify.cfargotunnel.com' }
    res.end(JSON.stringify({ result: dns.records ? [rec] : [] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return { w, root: path.join(w, 'root'), state: path.join(w, 'state'), calls: path.join(w, 'calls.log'), dns, server, port }
}

async function closeVm(vm: Vm) {
  await new Promise<void>((resolve) => vm.server.close(() => resolve()))
  fs.rmSync(vm.w, { recursive: true, force: true })
}

type Run = { code: number | null; signal: NodeJS.Signals | null; out: string }

// 起安裝腳本（非 dry-run、假 VM）。回傳子程序給「離開路徑」測試關管線、送訊號；done 在它結束後才解決。
function spawnInstall(vm: Vm, env: Record<string, string> = {}, opts: { detached?: boolean } = {}) {
  const w = vm.w
  const child = spawn('bash', [INSTALL, ...installArgs('--mem-available-override', '8000', '--offsite-dir', path.join(w, 'offsite'))], {
      detached: opts.detached ?? false,
      env: {
        NODE_ENV: 'test',
        PATH: `${path.join(w, 'bin')}:${process.env.PATH}`,
        HOME: w,
        LANG: 'C.UTF-8',
        CALLS_LOG: vm.calls,
        FAKE_STATE: vm.state,
        FAKE_TEAM: TEAM,
        FAKE_MOUNTED: path.join(w, 'mounted', 'config.yml'),
        FAKE_REAL_RENDER: RENDER,
        FAKE_TUNNEL_ID: TUNNEL_ID,
        FAKE_VERIFY_TUNNEL_ID: VERIFY_TUNNEL_ID,
        FJU_STATUS_APP_DIR: path.join(w, 'app'),
        FJU_STATUS_ROOT: vm.root,
        FJU_STATUS_UNIT_DIR: path.join(w, 'units'),
        FJU_STATUS_SSH_DIR: path.join(w, 'ssh'),
        FJU_STATUS_HOME_ROOT: path.join(w, 'home'),
        FJU_STATUS_SBIN: path.join(w, 'sbin'),
        FJU_STATUS_OS_RELEASE: path.join(w, 'os-release'),
        FJU_STATUS_RRSYNC: path.join(w, 'rrsync'),
        FJU_STATUS_CF_API: `http://127.0.0.1:${vm.port}`,
        ...env,
      },
    })
  let out = ''
  child.stdout.on('data', (d: Buffer) => (out += d))
  child.stderr.on('data', (d: Buffer) => (out += d))
  // 用 close（stdio 都收完）而不是 exit：測試要讀完整輸出；管線被 destroy 掉的那幾個 close 一樣會來。
  const done = new Promise<Run>((resolve) => {
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => resolve({ code, signal, out }))
  })
  return { child, done }
}

const installOnVm = (vm: Vm, env: Record<string, string> = {}) => spawnInstall(vm, env).done

async function waitFor(cond: () => boolean, what: string, ms = 10_000) {
  const until = Date.now() + ms
  while (!cond()) {
    if (Date.now() > until) throw new Error(`等不到：${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

const vmCalls = (vm: Vm) => fs.readFileSync(vm.calls, 'utf8').split('\n').filter(Boolean)
const marker = (vm: Vm) => path.join(vm.root, '.install', 'verify-7b.ok')
const logins = (vm: Vm) => fs.readFileSync(path.join(vm.state, 'logins'), 'utf8').split('\n').filter(Boolean).length
// 已經裝好過一次的機器：有 tunnel.json、第 7b 步的通過紀錄（同 team／AUD／版本／網址），重跑不用再登入。
function markInstalled(vm: Vm) {
  fs.mkdirSync(path.join(vm.root, 'secrets'), { recursive: true })
  fs.writeFileSync(path.join(vm.root, 'secrets', 'tunnel.json'), `{"TunnelID":"${TUNNEL_ID}"}`)
  fs.mkdirSync(path.join(vm.root, '.install'), { recursive: true })
  fs.writeFileSync(marker(vm), `team=${TEAM}\naud=${AUD}\ncloudflared=${CF_IMAGE}\nhosts=${HOSTS.join(' ')}\nat=2026-10-12T00:00:00Z\n`)
  fs.writeFileSync(path.join(vm.state, 'tunnel-fju-status'), '')
}

describe('故障注入：非 dry-run 整個流程（假 VM）', () => {
  let vm: Vm
  beforeEach(async () => {
    vm = await makeVm()
  })
  afterEach(async () => {
    await closeVm(vm)
  })

  it('基準：全部正常 → 結束碼 0、寫 7b 通過紀錄、守門通過才啟用自動更新、沒停任何 cloudflared', async () => {
    const r = await installOnVm(vm)
    expect(r.out).toContain('步驟 12：')
    expect(r.code).toBe(0)
    expect(fs.existsSync(marker(vm))).toBe(true)
    const c = vmCalls(vm)
    expect(c).toContain('systemctl enable --now fju-status-update.timer')
    expect(c.filter((x) => x.startsWith('docker stop'))).toEqual([])
    // 7b 兩輪真的跑過：假 origin 收到 3 個、暫時資源都清掉
    expect(fs.readFileSync(path.join(vm.state, 'networks'), 'utf8').trim()).toBe('')
    expect(fs.existsSync(path.join(vm.state, 'tunnel-fju-status-verify'))).toBe(false)
    expect(vm.dns.records).toBe(0)
  }, 30_000)

  it('P1：已安裝後重跑、第 7 步拒絕壞設定 → 停掉既有 cloudflared 與自動更新（timer、service），結束碼非 0', async () => {
    markInstalled(vm)
    const r = await installOnVm(vm, { FAKE_RENDER_BAD: '1' })
    expect(r.out).toContain('停在步驟 7')
    expect(r.code).not.toBe(0)
    const c = vmCalls(vm)
    expect(c).toContain('docker stop cid-cloudflared')
    expect(c).toContain('systemctl disable --now fju-status-update.timer')
    expect(c).toContain('systemctl stop fju-status-update.service')
    expect(c).not.toContain('systemctl enable --now fju-status-update.timer')
  }, 30_000)

  it('P1：前置一過、改設定之前就先停自動更新（安裝中途它不能 up -d）', async () => {
    markInstalled(vm)
    await installOnVm(vm, { FAKE_RENDER_BAD: '1' })
    const c = vmCalls(vm)
    const stopAt = c.findIndex((x) => x.startsWith('systemctl stop fju-status-update.timer'))
    const firstStatusUp = c.findIndex((x) => x.startsWith('status-up'))
    expect(stopAt).toBeGreaterThanOrEqual(0)
    expect(stopAt).toBeLessThan(firstStatusUp)
  }, 30_000)

  it('P2：DNS 清理失敗 → 不寫通過紀錄、結束碼非 0；修好後重跑會重新登入、重新做 7b', async () => {
    vm.dns.failDelete = true
    const r1 = await installOnVm(vm)
    expect(r1.code).not.toBe(0)
    expect(r1.out).toContain('不寫通過紀錄')
    expect(fs.existsSync(marker(vm))).toBe(false)
    expect(logins(vm)).toBe(1)

    vm.dns.failDelete = false
    const r2 = await installOnVm(vm)
    expect(logins(vm)).toBe(2)
    expect(r2.out).toContain('第一輪：有鎖')
    expect(r2.code).toBe(0)
    expect(fs.existsSync(marker(vm))).toBe(true)
  }, 60_000)

  it('P2：暫時網路刪不掉（docker network rm 失敗、還在清單裡）→ 不寫通過紀錄、結束碼非 0', async () => {
    const r = await installOnVm(vm, { FAKE_NETRM_FAIL: '1' })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('暫時網路 fju-status-verify 刪不掉或確認不了')
    expect(fs.existsSync(marker(vm))).toBe(false)
  }, 30_000)

  it('P3：第 11 步重起 Beszel agent 失敗（status-up 回 42）→ 摘要記 ✗、不記 ✓、結束碼非 0', async () => {
    const r = await installOnVm(vm, { FAKE_UP_FAIL: '1' })
    expect(r.out).toContain('步驟 11：✗')
    expect(r.out).not.toContain('步驟 11：✓')
    expect(r.code).not.toBe(0)
    // 守門已經通過，Beszel 失敗不關門
    expect(vmCalls(vm).filter((x) => x.startsWith('docker stop'))).toEqual([])
  }, 30_000)
})

// ---------------------------------------------------------------------------
// 離開路徑：守門（第 10 步）通過前，任何一種結束都要關門
// ---------------------------------------------------------------------------

describe('離開路徑都要關門：停 cloudflared 容器、停用 update timer、停 update service（第 10 步守門通過前）', () => {
  let vm: Vm
  beforeEach(async () => {
    vm = await makeVm()
  })
  afterEach(async () => {
    await closeVm(vm)
  })

  const DOOR = ['docker stop cid-cloudflared', 'systemctl disable --now fju-status-update.timer', 'systemctl stop fju-status-update.service']
  function expectDoorClosed() {
    const c = vmCalls(vm)
    for (const d of DOOR) expect(c).toContain(d)
    expect(c).not.toContain('systemctl enable --now fju-status-update.timer')
  }
  // 已裝過、但 tunnel.json 不見了：重跑會在第 7 步等授權（cloudflared tunnel login），此時守門已掛上、既有通道還開著。
  function markInstalledNeedLogin() {
    markInstalled(vm)
    fs.rmSync(path.join(vm.root, 'secrets', 'tunnel.json'))
  }
  const loginWaiting = () => fs.existsSync(path.join(vm.state, 'login-waiting'))
  const releaseLogin = (how: 'ok' | 'fail') => fs.writeFileSync(path.join(vm.state, 'login-go'), how)
  const loginDir = () => path.join(vm.root, '.cloudflared-login')
  const exitLog = () => fs.readFileSync(path.join(vm.root, '.install', 'exit.log'), 'utf8')

  it('P1：等授權時 stdout 與 stderr 管線都斷掉（像 `| tee` 死掉）→ 不是被 SIGPIPE 殺死，先關門、再刪 cert.pem；紀錄寫進 .install/exit.log', async () => {
    markInstalledNeedLogin()
    const { child, done } = spawnInstall(vm, { FAKE_LOGIN_BLOCK: '1' })
    await waitFor(loginWaiting, '假 login 等授權')
    child.stdout.destroy()
    child.stderr.destroy()
    releaseLogin('ok')
    const r = await done
    expect(r.signal).toBeNull()
    expect(r.code).not.toBe(0)
    expectDoorClosed()
    expect(fs.existsSync(loginDir())).toBe(false)
    expect(exitLog()).toContain('已停掉 cloudflared')
  }, 30_000)

  it('P1：只有 stdout 斷掉（stderr 還在）→ 一樣關門', async () => {
    markInstalledNeedLogin()
    const { child, done } = spawnInstall(vm, { FAKE_LOGIN_BLOCK: '1' })
    await waitFor(loginWaiting, '假 login 等授權')
    child.stdout.destroy()
    releaseLogin('ok')
    const r = await done
    expect(r.signal).toBeNull()
    expect(r.code).not.toBe(0)
    expectDoorClosed()
    expect(fs.existsSync(loginDir())).toBe(false)
  }, 30_000)

  it.each(['SIGINT', 'SIGHUP', 'SIGTERM'] as const)('等授權時收到 %s → 立刻砍掉 login 容器、關門、結束碼 128+n（不等 Roy 點授權）', async (sig) => {
    markInstalledNeedLogin()
    const { child, done } = spawnInstall(vm, { FAKE_LOGIN_BLOCK: '1' })
    await waitFor(loginWaiting, '假 login 等授權')
    child.kill(sig)
    const r = await done
    expect(r.signal).toBeNull()
    expect(r.code).toBeGreaterThan(128)
    expectDoorClosed()
    // login 容器被砍：起之前清一次舊的、on_exit 再砍一次（共兩次 rm -f）；假 login 沒跑完（沒寫 cert.pem、沒記 login）
    expect(vmCalls(vm).filter((x) => x === 'docker rm -f fju-status-login')).toHaveLength(2)
    expect(logins(vm)).toBe(0)
    expect(fs.existsSync(path.join(vm.state, 'login-go'))).toBe(false)
    expect(fs.existsSync(loginDir())).toBe(false)
    expect(exitLog()).toContain(sig === 'SIGINT' ? 'Ctrl-C' : sig)
  }, 30_000)

  it('正常失敗：授權沒成功（login 回非 0）→ halt 停在第 7 步、關門', async () => {
    markInstalledNeedLogin()
    const { done } = spawnInstall(vm, { FAKE_LOGIN_BLOCK: '1' })
    await waitFor(loginWaiting, '假 login 等授權')
    releaseLogin('fail')
    const r = await done
    expect(r.out).toContain('停在步驟 7')
    expect(r.code).toBe(1)
    expectDoorClosed()
    expect(fs.existsSync(loginDir())).toBe(false)
  }, 30_000)

  it('set -e：第 8 步 install 失敗（普通指令、沒接 halt）→ 關門、結束碼非 0、印出最後失敗的指令', async () => {
    markInstalled(vm)
    const r = await installOnVm(vm, { FAKE_INSTALL_FAIL: '1' })
    expect(r.signal).toBeNull()
    expect(r.code).not.toBe(0)
    expectDoorClosed()
    expect(r.out).toContain('最後失敗的指令')
    expect(r.out).toContain('fju-status-update.timer')
  }, 30_000)

  it('P2：有舊通過紀錄但 tunnel.json 遺失 → 決定重驗時先刪舊紀錄；清理失敗就沒有紀錄，再重跑會重做 7b，清乾淨才寫新紀錄', async () => {
    markInstalledNeedLogin()
    vm.dns.failDelete = true
    const r1 = await installOnVm(vm)
    expect(r1.code).not.toBe(0)
    expect(r1.out).toContain('不寫通過紀錄')
    expect(fs.existsSync(marker(vm))).toBe(false)
    expect(logins(vm)).toBe(1)
    expect(vm.dns.records).toBe(1)

    vm.dns.failDelete = false
    const r2 = await installOnVm(vm)
    expect(logins(vm)).toBe(2)
    expect(r2.out).toContain('第一輪：有鎖')
    expect(r2.code).toBe(0)
    expect(fs.existsSync(marker(vm))).toBe(true)
    expect(vm.dns.records).toBe(0)
  }, 60_000)

  it('第 10 步守門失敗（一個網址沒被擋）→ 關門、印出哪個網址、結束碼 1（AC-S-5）', async () => {
    markInstalled(vm)
    const r = await installOnVm(vm, { FAKE_UNGUARDED: 'fju-status-db.roy422.dev' })
    expect(r.out).toContain('fju-status-db.roy422.dev 沒被擋')
    expect(r.code).toBe(1)
    expectDoorClosed()
  }, 30_000)

  it.each(['SIGINT', 'SIGHUP', 'SIGTERM'] as const)('第 10 步守門失敗、關門途中收到 %s → 訊號不打斷關門：容器停、timer 停用、service 停都做完才結束（AC-S-5、AC-S-25 b）', async (sig) => {
    markInstalled(vm)
    const { child, done } = spawnInstall(vm, { FAKE_UNGUARDED: 'fju-status-db.roy422.dev', FAKE_DOOR_BLOCK: '1' })
    await waitFor(() => fs.existsSync(path.join(vm.state, 'door-closing')), '關門開始（systemctl disable 卡住）')
    child.kill(sig)
    fs.writeFileSync(path.join(vm.state, 'door-go'), '')
    const r = await done
    // 先驗門真的關了（舊碼：旗標提前設 1，EXIT trap 跳過 docker stop，卻印「已停掉」）
    expectDoorClosed()
    expect(r.signal).toBeNull()
    expect(r.code).toBe(1)
    expect(exitLog()).toContain('已停掉 cloudflared')
  }, 30_000)

  it.each(['SIGINT', 'SIGTERM'] as const)('守門失敗、關門途中對整個程序群組送 %s（終端按 Ctrl-C 就是這樣）→ 容器列舉在別的 session、不被打斷，cloudflared 照樣停', async (sig) => {
    markInstalled(vm)
    const { child, done } = spawnInstall(vm, { FAKE_UNGUARDED: 'fju-status-db.roy422.dev', FAKE_PS_SLOW: '1' }, { detached: true })
    await waitFor(() => fs.existsSync(path.join(vm.state, 'ps-running')), '關門時的容器列舉開始')
    if (!child.pid) throw new Error('沒有 pid')
    process.kill(-child.pid, sig)
    fs.writeFileSync(path.join(vm.state, 'ps-go'), '')
    const r = await done
    expectDoorClosed()
    expect(r.signal).toBeNull()
    expect(r.code).toBe(1)
    expect(exitLog()).toContain('已停掉 cloudflared')
    expect(exitLog()).not.toContain('沒有全部成功')
  }, 30_000)

  it('守門失敗、容器列舉一直失敗（docker ps 回非 0）→ 不當成空清單：重試三次後改用名稱 fju-status-cloudflared-1 直接 stop，log 說明', async () => {
    markInstalled(vm)
    const r = await installOnVm(vm, { FAKE_UNGUARDED: 'fju-status-db.roy422.dev', FAKE_PS_FAIL: '1' })
    const c = vmCalls(vm)
    expect(c.filter((x) => x === 'docker ps -q --filter label=com.docker.compose.project=fju-status --filter label=com.docker.compose.service=cloudflared')).toHaveLength(3)
    expect(c).toContain('docker stop fju-status-cloudflared-1')
    expect(c).toContain('systemctl disable --now fju-status-update.timer')
    expect(c).toContain('systemctl stop fju-status-update.service')
    expect(r.code).toBe(1)
    expect(exitLog()).toContain('列舉三次都失敗')
  }, 30_000)

  it('守門失敗、systemctl stop／disable 與狀態查詢（show）都失敗 → timer、service 不算停好：記失敗、印手動指令、結束碼非 0、不印已停掉', async () => {
    markInstalled(vm)
    const r = await installOnVm(vm, { FAKE_UNGUARDED: 'fju-status-db.roy422.dev', FAKE_SYSTEMCTL_FAIL: '1' })
    expect(r.code).not.toBe(0)
    const log = exitLog()
    expect(log).toContain('關門沒有全部成功')
    expect(log).toContain('fju-status-update.timer（')
    expect(log).toContain('fju-status-update.service（')
    expect(log).toContain('systemctl disable --now fju-status-update.timer')
    expect(log).not.toContain('已停掉 cloudflared')
    expect(vmCalls(vm)).toContain('docker stop cid-cloudflared')
  }, 30_000)

  it('守門失敗、列舉與名稱 stop 都失敗 → 不設關門旗標：印清楚要手動做什麼、結束碼非 0', async () => {
    markInstalled(vm)
    const r = await installOnVm(vm, { FAKE_UNGUARDED: 'fju-status-db.roy422.dev', FAKE_PS_FAIL: '1', FAKE_STOP_FAIL: '1' })
    expect(r.code).not.toBe(0)
    expect(exitLog()).toContain('關門沒有全部成功')
    expect(exitLog()).toContain('docker stop')
    expect(exitLog()).not.toContain('已停掉 cloudflared')
  }, 30_000)
})
