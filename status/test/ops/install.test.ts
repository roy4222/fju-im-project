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
  compose|stats|pull|stop|exec)
    [ "$1" = exec ] && echo fjudb
    exit 0 ;;
  ps)
    if [ "$2" = -a ]; then cat "$S/containers"; exit 0; fi
    svc=$(printf '%s\n' "$@" | sed -n 's/^label=com.docker.compose.service=//p')
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
        --network|--memory|--user|-e|--pull) shift ;;
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
          if grep -q 'access:' "$cfg"; then echo locked > "$S/cf_mode"; else echo open > "$S/cf_mode"; fi
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
            tok=$(printf '{"zoneID":"z1","accountID":"a1","apiToken":"t1"}' | base64 | tr -d '\n')
            printf -- '-----BEGIN ARGO TUNNEL TOKEN-----\n%s\n-----END ARGO TUNNEL TOKEN-----\n' "$tok" > "$login/cert.pem"
            echo login >> "$S/logins" ;;
          list)
            if [ -f "$S/tunnel-$n" ]; then printf '[{"id":"id-%s","name":"%s"}]' "$n" "$n"; else echo '[]'; fi ;;
          create|token)
            touch "$S/tunnel-$last"
            printf '{"TunnelID":"id-%s"}' "$last" > "$login/$(basename "$cred")" ;;
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
  https://*/) h=@{url#https://}; printf '302 https://%s/cdn-cgi/access/login/%s' "$FAKE_TEAM" "@{h%/}" ;;
esac
`)

const FAKE_SIMPLE: Record<string, string> = {
  id: `#!/bin/sh\n[ "$1" = -u ] && echo 0\nexit 0\n`,
  systemctl: `#!/bin/sh\necho "systemctl $*" >> "$CALLS_LOG"\ncase "$1" in is-*) exit 1 ;; esac\nexit 0\n`,
  runuser: `#!/bin/sh\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n`,
  install: `#!/bin/sh\nargs=""\nwhile [ $# -gt 0 ]; do case "$1" in -o|-g) shift ;; *) args="$args '$1'" ;; esac; shift; done\neval exec /usr/bin/install $args\n`,
  chown: `#!/bin/sh\nexit 0\n`,
  useradd: `#!/bin/sh\necho "useradd $*" >> "$CALLS_LOG"\n`,
  sshd: `#!/bin/sh\nexit 0\n`,
  'ssh-keygen': `#!/bin/sh\necho "ssh-ed25519 AAAAFakeHubKey beszel"\n`,
  sleep: `#!/bin/sh\nexit 0\n`,
}

// 假產生器：照 STATUS_HOSTS 產四條 ingress；FAKE_RENDER_BAD=1 時故意不帶 access（壞設定）。
const FAKE_RENDER = bash(String.raw`#!/bin/bash
while [ $# -gt 0 ]; do case "$1" in --team) t=$2; shift ;; --aud) a=$2; shift ;; --tunnel-id) id=$2; shift ;; --out) o=$2; shift ;; esac; shift; done
{
  echo "tunnel: $id"
  echo "credentials-file: /etc/cloudflared/tunnel.json"
  echo "ingress:"
  for h in $STATUS_HOSTS; do
    echo "  - hostname: $h"
    echo "    service: http://status-web:3000"
    if [ "@{FAKE_RENDER_BAD:-0}" != 1 ]; then
      printf '    originRequest:\n      access:\n        required: true\n        teamName: %s\n        audTag:\n          - %s\n' "$t" "$a"
    fi
  done
  echo "  - service: http_status:404"
} > "$o"
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
  put('mounted/config.yml', goodConfigFor(TEAM.split('.')[0]))
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

function goodConfigFor(team: string) {
  return goodConfig().replaceAll('teamName: royteam', `teamName: ${team}`)
}

function installOnVm(vm: Vm, env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  const w = vm.w
  return new Promise((resolve) => {
    const child = spawn('bash', [INSTALL, ...installArgs('--mem-available-override', '8000', '--offsite-dir', path.join(w, 'offsite'))], {
      env: {
        PATH: `${path.join(w, 'bin')}:${process.env.PATH}`,
        HOME: w,
        LANG: 'C.UTF-8',
        CALLS_LOG: vm.calls,
        FAKE_STATE: vm.state,
        FAKE_TEAM: TEAM,
        FAKE_MOUNTED: path.join(w, 'mounted', 'config.yml'),
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
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => resolve({ code, out }))
  })
}

const vmCalls = (vm: Vm) => fs.readFileSync(vm.calls, 'utf8').split('\n').filter(Boolean)
const marker = (vm: Vm) => path.join(vm.root, '.install', 'verify-7b.ok')
const logins = (vm: Vm) => fs.readFileSync(path.join(vm.state, 'logins'), 'utf8').split('\n').filter(Boolean).length
// 已經裝好過一次的機器：有 tunnel.json、第 7b 步的通過紀錄（同 team／AUD／版本／網址），重跑不用再登入。
function markInstalled(vm: Vm) {
  fs.mkdirSync(path.join(vm.root, 'secrets'), { recursive: true })
  fs.writeFileSync(path.join(vm.root, 'secrets', 'tunnel.json'), '{"TunnelID":"id-fju-status"}')
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
