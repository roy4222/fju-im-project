/**
 * 教學環境防呆的測試：危險輸入一定被拒絕。不真的刪任何東西——純函式用假資料，
 * 腳本層的測試把 HOME 指到暫存目錄，確認入口在任何副作用之前就停下。
 *
 *   node --test tools/tutorial/env/
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, describe, test } from 'node:test'
import {
  SafetyError,
  checkDbName,
  checkDocker,
  checkFilesDir,
  checkPgUrl,
  instanceOf,
  mismatch,
  parseAccountsFile,
  probeProcess,
  validateAccounts,
} from './safety.mjs'

const HERE = import.meta.dirname
const requireWeb = createRequire(path.join(HERE, '..', '..', '..', 'web', 'package.json'))
const { parse } = createRequire(requireWeb.resolve('pg'))('pg-connection-string')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tutorial-safety-'))
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

/**
 * 假的 Docker socket：任何連線都回 HTTP 500 然後關掉，docker CLI 會馬上失敗而不是等到天荒地老。
 * 跑在另一個 node 程序裡——測試用 spawnSync 跑腳本時這個測試程序是卡住的，server 若在同一個程序就永遠回不了話。
 */
const FAKE_DOCKER_SERVER = `
  const net = require('node:net'), fs = require('node:fs')
  const sock = process.argv[1]
  try { fs.unlinkSync(sock) } catch {}
  net.createServer((c) => { c.on('error', () => {}); c.end('HTTP/1.1 500 Internal Server Error\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n') }).listen(sock)
`
async function fakeDockerSocket(sock) {
  const p = spawn('node', ['-e', FAKE_DOCKER_SERVER, sock], { stdio: 'ignore' })
  after(() => p.kill('SIGKILL'))
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await new Promise((resolve) => setTimeout(resolve, 100))
  assert.ok(fs.existsSync(sock), `假的 docker socket 沒起來：${sock}`)
}

describe('INSTANCE 與資料庫名（第 3 點＋多實例）', () => {
  test('INSTANCE 只收 0～4', () => {
    assert.deepEqual(instanceOf(undefined), { n: 0, dbName: 'fju_tutorial', port: 3300 })
    assert.deepEqual(instanceOf('3'), { n: 3, dbName: 'fju_tutorial_3', port: 3303 })
    for (const bad of ['5', '-1', '01', '1 ', '1;drop', 'a', '10']) assert.throws(() => instanceOf(bad), SafetyError, bad)
  })

  test('只接受 fju_tutorial 與 fju_tutorial_1～4', () => {
    for (const ok of ['fju_tutorial', 'fju_tutorial_1', 'fju_tutorial_4']) assert.equal(checkDbName(ok), ok)
    for (const bad of ['fju', 'fju_w3_e2e', 'fju_tutorial_5', 'fju_tutorial_0', 'fju_tutorial_x', 'postgres', 'fju_tutorial;', ''])
      assert.throws(() => checkDbName(bad), SafetyError, bad)
  })

  test('名字合法但不是這個實例的也拒絕', () => {
    assert.throws(() => checkDbName('fju_tutorial_1', 'fju_tutorial'), SafetyError)
    assert.throws(() => checkDbName('fju_tutorial', 'fju_tutorial_2'), SafetyError)
  })
})

describe('連線字串只能指到本機這個實例的庫（第 4 點）', () => {
  const ok = 'postgres://fju_owner:pw@127.0.0.1:55432/fju_tutorial'
  test('本機 loopback 都可以', () => {
    assert.equal(checkPgUrl(ok, parse, 'fju_tutorial').database, 'fju_tutorial')
    checkPgUrl('postgres://u:p@localhost:55432/fju_tutorial_2', parse, 'fju_tutorial_2')
    checkPgUrl('postgres://u:p@[::1]:55432/fju_tutorial', parse, 'fju_tutorial')
  })
  const bad = {
    '?host= 改寫目的地': `${ok}?host=db.example.com`,
    '?host= 指 unix socket': `${ok}?host=/tmp`,
    '?hostaddr=': `${ok}?hostaddr=10.0.0.1`,
    '?dbname=': `${ok}?dbname=fju`,
    '?options=': `${ok}?options=-c%20search_path%3Devil`,
    '遠端 host': 'postgres://u:p@db.example.com:55432/fju_tutorial',
    '區網 IP': 'postgres://u:p@192.168.1.10:55432/fju_tutorial',
    '沒寫 host（會退回 PGHOST）': 'postgres://u:p@/fju_tutorial',
    '別的 port': 'postgres://u:p@127.0.0.1:5432/fju_tutorial',
    '沒寫 port': 'postgres://u:p@127.0.0.1/fju_tutorial',
    '別的庫': 'postgres://u:p@127.0.0.1:55432/fju_w3_e2e',
    '別的實例的庫': 'postgres://u:p@127.0.0.1:55432/fju_tutorial_1',
    '不是 postgres://': 'mysql://u:p@127.0.0.1:55432/fju_tutorial',
  }
  for (const [name, url] of Object.entries(bad)) {
    test(`拒絕：${name}`, () => assert.throws(() => checkPgUrl(url, parse, 'fju_tutorial'), SafetyError))
  }
})

describe('FILES_ROOT 只能是 ~/work/tutorial-files/<n>（第 1 點＋多實例）', () => {
  const home = path.join(tmp, 'home')
  const root0 = path.join(home, 'work', 'tutorial-files', '0')
  fs.mkdirSync(root0, { recursive: true })
  fs.mkdirSync(path.join(home, 'elsewhere'), { recursive: true })
  fs.symlinkSync(path.join(home, 'elsewhere'), path.join(root0, 'escape'))
  fs.symlinkSync(home, path.join(home, 'work', 'tutorial-files', 'link-to-home'))
  const realRoot0 = fs.realpathSync(root0)

  test('實例自己的目錄與子目錄可以（還不存在的也可以）', () => {
    assert.equal(checkFilesDir(root0, home, 0), realRoot0)
    assert.equal(checkFilesDir(path.join(root0, 'a', 'b'), home, 0), path.join(realRoot0, 'a', 'b'))
  })
  const bad = {
    'HOME 本身': () => home,
    'HOME/': () => `${home}/`,
    '~/work': () => path.join(home, 'work'),
    'tutorial-files 根目錄（含所有實例）': () => path.join(home, 'work', 'tutorial-files'),
    '別的實例的目錄': () => path.join(home, 'work', 'tutorial-files', '1'),
    '名字相近的兄弟目錄': () => `${root0}-other`,
    '用 .. 爬出去': () => path.join(root0, '..', '..'),
    '符號連結指到外面': () => path.join(root0, 'escape'),
    '經符號連結回到 HOME': () => path.join(home, 'work', 'tutorial-files', 'link-to-home', 'work', 'tutorial-files', '0', '..', '..'),
    '根目錄 /': () => '/',
    '空字串': () => '',
  }
  for (const [name, dir] of Object.entries(bad)) {
    test(`拒絕：${name}`, () => assert.throws(() => checkFilesDir(dir(), home, 0), SafetyError))
  }
})

describe('Docker 只走本機 unix socket（第 5 點）', () => {
  const sock = path.join(tmp, 'd.sock')

  test('本機 socket 可以', async () => {
    await fakeDockerSocket(sock)
    assert.equal(checkDocker({ HOME: tmp, TUTORIAL_DOCKER_SOCK: sock }), `unix://${sock}`)
    assert.equal(checkDocker({ HOME: tmp, TUTORIAL_DOCKER_SOCK: sock, DOCKER_HOST: `unix://${sock}` }), `unix://${sock}`)
  })
  for (const host of ['tcp://10.0.0.5:2375', 'ssh://user@vm', 'tcp://127.0.0.1:2375', 'npipe:////./pipe/docker_engine']) {
    test(`拒絕 DOCKER_HOST=${host}`, () => assert.throws(() => checkDocker({ HOME: tmp, TUTORIAL_DOCKER_SOCK: sock, DOCKER_HOST: host }), SafetyError))
  }
  test('拒絕不存在的 socket、一般檔案、相對路徑', () => {
    const file = path.join(tmp, 'not-a-socket')
    fs.writeFileSync(file, '')
    assert.throws(() => checkDocker({ HOME: tmp, TUTORIAL_DOCKER_SOCK: path.join(tmp, 'nope.sock') }), SafetyError)
    assert.throws(() => checkDocker({ HOME: tmp, TUTORIAL_DOCKER_SOCK: file }), SafetyError)
    assert.throws(() => checkDocker({ HOME: tmp, TUTORIAL_DOCKER_SOCK: 'd.sock' }), SafetyError)
  })
})

describe('程序身分核對（第 2 點）', () => {
  const meta = { kind: 'worker', pid: '4242', pgid: '4242', lstart: 'Tue Oct 13 08:26:25 2026', cwd: '/repo/web' }
  const live = { pgid: '4242', lstart: 'Tue Oct 13 08:26:25 2026', command: 'node dist/worker.mjs', cwd: '/repo/web' }
  const probe = (over) => () => ({ ...live, ...over })

  test('全部對得上才算是我們的', () => assert.equal(mismatch(meta, probe({})), null))
  test('app 改名成 next-server 之後也認得', () =>
    assert.equal(mismatch({ ...meta, kind: 'app' }, probe({ command: 'next-server (v16.3.8)' })), null))
  const bad = {
    '程序不在了': [meta, () => null],
    'pid 被重用（啟動時間不同）': [meta, probe({ lstart: 'Wed Oct 14 09:00:00 2026' })],
    '工作目錄不同': [meta, probe({ cwd: '/elsewhere' })],
    '種類不同（別人的 next-server）': [meta, probe({ command: 'next-server (v16.3.8)' })],
    'PGID 不同': [meta, probe({ pgid: '1' })],
    'pid 不是自己那組的 leader': [{ ...meta, pgid: '1' }, probe({ pgid: '1' })],
    'pid 檔殘留舊格式（只有數字）': [4242, probe({})],
    'pid 檔是空的': [null, probe({})],
  }
  for (const [name, [m, p]] of Object.entries(bad)) test(`不符：${name}`, () => assert.notEqual(mismatch(m, p), null))

  test('probeProcess 讀得到真的程序', () => {
    const p = probeProcess(process.pid)
    assert.equal(p.pgid.length > 0, true)
    assert.match(p.lstart, /^\w{3} \w{3} +\d+ [\d:]+ \d{4}$/)
    assert.equal(p.cwd, fs.realpathSync(process.cwd()))
  })
})

describe('帳號設定檔錯誤訊息（第 6 點）', () => {
  test('只列索引與缺的欄位，不印整筆（不含密碼）', () => {
    const config = { accounts: [{ role: '組長', name: '甲', password: 'ok-1' }, { name: '乙', password: 'Secret-Should-Not-Leak' }] }
    assert.throws(
      () => validateAccounts(config),
      (e) => e instanceof SafetyError && /accounts\[1\]/.test(e.message) && /role/.test(e.message) && !e.message.includes('Secret-Should-Not-Leak') && !e.message.includes('乙'),
    )
    assert.throws(
      () => validateAccounts({ accounts: [{ role: '系辦', create: 'admin', name: 'x', password: 'Secret-2' }] }),
      (e) => /accounts\[0\]/.test(e.message) && /email/.test(e.message) && !e.message.includes('Secret-2'),
    )
  })
})

// ── 腳本層：真的跑入口，但 HOME 指到暫存目錄，確認在副作用之前就拒絕 ─────────────

describe('入口在副作用之前拒絕危險輸入', () => {
  const home = path.join(tmp, 'script-home')
  fs.mkdirSync(home, { recursive: true })
  const sentinel = path.join(home, 'keep-me')
  fs.writeFileSync(sentinel, 'x')
  const sock = path.join(tmp, 's.sock')
  const run = (script, env) =>
    spawnSync(path.join(HERE, script), [], {
      env: { PATH: process.env.PATH, HOME: home, TUTORIAL_DOCKER_SOCK: sock, ...env },
      encoding: 'utf8',
    })
  const untouched = () => {
    assert.ok(fs.existsSync(sentinel), 'HOME 裡的檔案還在')
    assert.ok(!fs.existsSync(path.join(home, 'work')), '沒有建任何目錄')
  }

  test('準備假的 docker socket', async () => {
    await fakeDockerSocket(sock)
  })
  const cases = {
    'reset：FILES_ROOT 指到 HOME': ['reset.sh', { TUTORIAL_FILES_DIR: home }],
    'reset：FILES_ROOT 指到 HOME/': ['reset.sh', { TUTORIAL_FILES_DIR: `${home}/` }],
    'reset：FILES_ROOT 指到別的實例': ['reset.sh', { INSTANCE: '1', TUTORIAL_FILES_DIR: path.join(home, 'work', 'tutorial-files', '2') }],
    'reset：INSTANCE=5': ['reset.sh', { INSTANCE: '5' }],
    'reset：TUTORIAL_DB 改成別的庫': ['reset.sh', { TUTORIAL_DB: 'fju_w3_e2e' }],
    'reset：DOCKER_HOST 指到遠端': ['reset.sh', { DOCKER_HOST: 'tcp://10.0.0.5:2375' }],
    'up：DOCKER_HOST 指到遠端': ['up.sh', { DOCKER_HOST: 'ssh://user@vm' }],
    'up：INSTANCE 不是數字': ['up.sh', { INSTANCE: '1;rm' }],
    'down：INSTANCE=9': ['down.sh', { INSTANCE: '9' }],
    'clock-reset：INSTANCE=5': ['clock-reset.sh', { INSTANCE: '5' }],
    'clock-reset：TUTORIAL_DB 改成別的庫': ['clock-reset.sh', { TUTORIAL_DB: 'fju' }],
    'clock-reset：DOCKER_HOST 指到遠端': ['clock-reset.sh', { DOCKER_HOST: 'tcp://10.0.0.5:2375' }],
  }
  for (const [name, [script, env]] of Object.entries(cases)) {
    test(name, () => {
      const r = run(script, env)
      assert.notEqual(r.status, 0, r.stdout + r.stderr)
      untouched()
    })
  }

  test('accounts.mjs：DATABASE_URL_OWNER 帶 ?host= 被拒絕，也不建設定檔', () => {
    const r = spawnSync('node', [path.join(HERE, 'accounts.mjs'), 'apply'], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TUTORIAL_SECRETS_DIR: path.join(home, 'secrets'),
        DATABASE_URL_OWNER: 'postgres://fju_owner:pw@127.0.0.1:55432/fju_tutorial?host=db.example.com',
      },
      encoding: 'utf8',
    })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /拒絕執行/)
    assert.ok(!fs.existsSync(path.join(home, 'secrets')))
  })

  test('accounts.mjs：DATABASE_URL_OWNER 跟 INSTANCE 不一致被拒絕', () => {
    const r = spawnSync('node', [path.join(HERE, 'accounts.mjs'), 'apply'], {
      env: { PATH: process.env.PATH, HOME: home, INSTANCE: '2', TUTORIAL_SECRETS_DIR: path.join(home, 'secrets'), DATABASE_URL_OWNER: 'postgres://u:p@127.0.0.1:55432/fju_tutorial' },
      encoding: 'utf8',
    })
    assert.equal(r.status, 1)
    assert.ok(!fs.existsSync(path.join(home, 'secrets')))
  })

  test('down：pid 檔指到別人的程序（啟動時間不符）只清 pid 檔、不送訊號', async () => {
    // 一個跟我們無關的程序：pid 檔記的 pid 對，但啟動時間是假的（模擬 pid 被重用）。
    const victim = spawn('sleep', ['30'], { stdio: 'ignore' })
    after(() => victim.kill())
    const runDir = path.join(tmp, 'run')
    fs.mkdirSync(path.join(runDir, '0'), { recursive: true })
    const meta = { kind: 'worker', pid: String(victim.pid), pgid: String(victim.pid), lstart: 'Thu Jan  1 00:00:00 2026', cwd: '/nowhere' }
    fs.writeFileSync(path.join(runDir, '0', 'worker.pid'), JSON.stringify(meta))
    fs.writeFileSync(path.join(runDir, '0', 'app.pid'), String(victim.pid))
    const r = spawnSync(path.join(HERE, 'down.sh'), [], { env: { PATH: process.env.PATH, HOME: home, TUTORIAL_RUN_DIR: runDir }, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /只清掉 pid 檔、不送訊號/)
    assert.ok(!fs.existsSync(path.join(runDir, '0', 'worker.pid')))
    assert.ok(!fs.existsSync(path.join(runDir, '0', 'app.pid')))
    assert.equal(victim.exitCode, null, 'sleep 還活著')
    execFileSync('kill', ['-0', String(victim.pid)])
  })
})

// ── Review 第 2 次退回第 3 項：macOS 內建 Bash 3.2 在 UTF-8 locale 下把 `$VAR（` 讀成變數名「VAR（」 ─────────

describe('Bash 3.2（/bin/bash）在 LANG=zh_TW.UTF-8 下跑得動', () => {
  const home = path.join(tmp, 'zh-home')
  fs.mkdirSync(home, { recursive: true })
  const sock = path.join(tmp, 'zh.sock')
  test('準備假的 docker socket', async () => {
    await fakeDockerSocket(sock)
  })
  const zh = { LANG: 'zh_TW.UTF-8', LC_ALL: 'zh_TW.UTF-8' }
  const runBash = (script, args, env) =>
    spawnSync('/bin/bash', [path.join(HERE, script), ...args], {
      env: { PATH: process.env.PATH, HOME: home, TUTORIAL_DOCKER_SOCK: sock, ...zh, ...env },
      encoding: 'utf8',
    })

  test('程式行裡沒有「$變數」後面緊接非 ASCII 字（要寫成 ${變數}）', () => {
    const offenders = []
    for (const f of fs.readdirSync(HERE).filter((n) => n.endsWith('.sh'))) {
      fs.readFileSync(path.join(HERE, f), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*#/.test(line)) return
          if (/\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`)
        })
    }
    assert.deepEqual(offenders, [])
  })

  test('INSTANCE 不合法時印的是正常的錯誤訊息（含全形括號），不是 unbound variable', () => {
    const r = runBash('up.sh', [], { INSTANCE: '7' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stderr, /收到「7」/)
    assert.doesNotMatch(r.stderr, /unbound variable/)
  })

  test('up.sh --dry-run：走完 safety_check、印出這個實例的設定，什麼都不建', () => {
    const r = runBash('up.sh', ['--dry-run'], { INSTANCE: '2' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /fju_tutorial_2/)
    assert.match(r.stdout, /localhost:3302/)
    assert.doesNotMatch(r.stdout + r.stderr, /unbound variable/)
    assert.ok(!fs.existsSync(path.join(home, 'work')), 'dry-run 沒有建任何目錄')
  })
})

// ── Review 第 2 次退回第 1 項：實例目錄本身（或上層 work／tutorial-files）是符號連結 ──────────────

describe('FILES_ROOT 的邊界是固定的，邊界上的任何一層都不能是符號連結', () => {
  const home = path.join(tmp, 'symlink-home')
  const tf = path.join(home, 'work', 'tutorial-files')
  fs.mkdirSync(path.join(tf, '1'), { recursive: true })
  fs.symlinkSync(path.join(tf, '1'), path.join(tf, '0')) // 0 → 1：別的實例
  fs.symlinkSync(home, path.join(tf, '2')) // 2 → HOME
  fs.mkdirSync(path.join(tf, '3'), { recursive: true })
  const sentinel = path.join(tf, '1', 'keep-me')
  fs.writeFileSync(sentinel, 'x')

  test('實例目錄是指到別的實例的符號連結 → 拒絕', () => {
    assert.throws(() => checkFilesDir(path.join(tf, '0'), home, 0), SafetyError)
    assert.throws(() => checkFilesDir(path.join(tf, '0', 'sub'), home, 0), SafetyError)
  })
  test('實例目錄是指到 HOME 的符號連結 → 拒絕', () => {
    assert.throws(() => checkFilesDir(path.join(tf, '2'), home, 2), SafetyError)
  })
  test('真的目錄照常可以，HOME 本身是符號連結也可以', () => {
    assert.equal(checkFilesDir(path.join(tf, '3'), home, 3), fs.realpathSync(path.join(tf, '3')))
    const homeLink = path.join(tmp, 'symlink-home-link')
    fs.symlinkSync(home, homeLink)
    assert.equal(checkFilesDir(path.join(homeLink, 'work', 'tutorial-files', '3'), homeLink, 3), fs.realpathSync(path.join(tf, '3')))
  })
  test('tutorial-files 或 work 這一層是符號連結 → 拒絕', () => {
    const h2 = path.join(tmp, 'symlink-home-2')
    fs.mkdirSync(path.join(h2, 'elsewhere', '0'), { recursive: true })
    fs.mkdirSync(path.join(h2, 'work'), { recursive: true })
    fs.symlinkSync(path.join(h2, 'elsewhere'), path.join(h2, 'work', 'tutorial-files'))
    assert.throws(() => checkFilesDir(path.join(h2, 'work', 'tutorial-files', '0'), h2, 0), SafetyError)
    const h3 = path.join(tmp, 'symlink-home-3')
    fs.mkdirSync(path.join(h3, 'elsewhere', 'tutorial-files', '0'), { recursive: true })
    fs.symlinkSync(path.join(h3, 'elsewhere'), path.join(h3, 'work'))
    assert.throws(() => checkFilesDir(path.join(h3, 'work', 'tutorial-files', '0'), h3, 0), SafetyError)
  })

  const sock = path.join(tmp, 'sym.sock')
  test('reset.sh：實例目錄是符號連結時在任何副作用之前退出', async () => {
    await fakeDockerSocket(sock)
    const secrets = path.join(home, 'secrets')
    const r = spawnSync(path.join(HERE, 'reset.sh'), [], {
      env: { PATH: process.env.PATH, HOME: home, TUTORIAL_DOCKER_SOCK: sock, TUTORIAL_SECRETS_DIR: secrets, INSTANCE: '0' },
      encoding: 'utf8',
    })
    assert.notEqual(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stderr, /符號連結/)
    assert.ok(!fs.existsSync(secrets), '沒有進到 load_env（沒建 secrets 目錄）')
    assert.ok(!fs.existsSync(path.join(home, 'work', 'tutorial-run')), '沒建 run 目錄')
    assert.ok(fs.existsSync(sentinel), '實例 1 的檔案還在')
  })
})

// ── Review 第 2 次退回第 2 項：帳號 JSON 格式錯誤時，JSON.parse 的訊息會帶出檔案內容（含密碼片段） ──────

describe('帳號設定檔格式錯誤時只印固定訊息，不印內容', () => {
  const broken = '{"accounts":[{"role":"組長","name":"甲","password":"Secret-Leak-XYZ"},,]}'
  test('parseAccountsFile：錯誤訊息只有檔名＋「格式錯誤」', () => {
    assert.throws(
      () => parseAccountsFile(broken, '/x/accounts.json'),
      (e) => e instanceof SafetyError && e.message.includes('/x/accounts.json') && e.message.includes('格式錯誤') && !e.message.includes('Secret-Leak') && !e.message.includes('Unexpected'),
    )
    assert.deepEqual(parseAccountsFile('{"accounts":[]}', '/x/a.json'), { accounts: [] })
  })
  test('accounts.mjs apply：畸形 JSON 不會把內容印到 stderr', () => {
    const home = path.join(tmp, 'json-home')
    const secrets = path.join(home, 'secrets')
    fs.mkdirSync(secrets, { recursive: true })
    fs.writeFileSync(path.join(secrets, 'accounts.json'), broken)
    const r = spawnSync('node', [path.join(HERE, 'accounts.mjs'), 'apply'], {
      env: { PATH: process.env.PATH, HOME: home, TUTORIAL_SECRETS_DIR: secrets },
      encoding: 'utf8',
    })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stderr, /格式錯誤/)
    assert.ok(!(r.stdout + r.stderr).includes('Secret-Leak'), `內容外洩：${r.stderr}`)
    assert.ok(!(r.stdout + r.stderr).includes('Unexpected'), `JSON.parse 原始訊息外洩：${r.stderr}`)
  })
})

// ── 多實例共用鎖（Review 第 2 次第 4 項；第 3 次改成不自動回收殘留鎖） ───────────────────────────

/**
 * 假的「已建置好的網站 checkout」：有 git（HEAD:web 算得出來）、web/package.json、node_modules、.next/BUILD_ID、dist/worker.mjs，
 * build mark 寫成 HEAD 的 web tree。require_built 才會過。
 */
function fakeBuiltSite(dir, runDir) {
  fs.mkdirSync(path.join(dir, 'web', '.next'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'web', 'dist'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'web', 'node_modules'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'web', 'package.json'), '{}')
  fs.writeFileSync(path.join(dir, 'web', '.next', 'BUILD_ID'), 'x')
  fs.writeFileSync(path.join(dir, 'web', 'dist', 'worker.mjs'), '')
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('add', 'web/package.json')
  git('commit', '-q', '-m', 'fake')
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'build-commit'), `${git('rev-parse', 'HEAD:web')}\n`)
  return dir
}

describe('多實例共用鎖（lock_acquire／lock_release）', () => {
  const lib = path.join(HERE, 'lib.sh')
  const home = path.join(tmp, 'lock-home')
  fs.mkdirSync(home, { recursive: true })
  const sock = path.join(tmp, 'lock.sock')
  test('準備假的 docker socket', async () => {
    await fakeDockerSocket(sock)
  })
  let seq = 0
  const freshRun = () => {
    const d = path.join(tmp, `lock-run-${seq++}`)
    fs.mkdirSync(d, { recursive: true })
    return d
  }
  const baseEnv = (runDir, extra) => ({ PATH: process.env.PATH, HOME: home, TUTORIAL_RUN_DIR: runDir, TUTORIAL_DOCKER_SOCK: sock, ...extra })
  /** 一個「別人」：拿到鎖後印 HELD，再睡 holdSeconds 秒（正常結束時 EXIT trap 會放鎖）。整個 process group 獨立，方便整組殺掉。 */
  const holder = (runDir, what, holdSeconds) => {
    const p = spawn('/bin/bash', ['-c', 'source "$1" && lock_acquire "$2" && echo HELD && sleep "$3"', '_', lib, what, String(holdSeconds)], {
      env: baseEnv(runDir),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    const ready = new Promise((resolve, reject) => {
      let out = ''
      let err = ''
      p.stdout.on('data', (d) => {
        out += d
        if (out.includes('HELD')) resolve()
      })
      p.stderr.on('data', (d) => (err += d))
      p.on('exit', (code) => reject(new Error(`holder 先結束了（${code}）：${err}`)))
    })
    const killAll = () => {
      try {
        process.kill(-p.pid, 'SIGKILL')
      } catch {}
    }
    after(killAll)
    return { p, ready, killAll }
  }
  const acquire = (runDir, what, timeout) =>
    spawnSync('/bin/bash', ['-c', 'source "$1" && lock_acquire "$2" && echo GOT', '_', lib, what], {
      env: baseEnv(runDir, { TUTORIAL_LOCK_TIMEOUT: String(timeout) }),
      encoding: 'utf8',
    })

  test('別人持鎖時，逾時就失敗：訊息寫出鎖的路徑、持有者 pid（仍在）、在做什麼、要人手動刪', async () => {
    const runDir = freshRun()
    const h = holder(runDir, '測試用建置', 60)
    await h.ready
    const r = acquire(runDir, '第二個', 1)
    assert.notEqual(r.status, 0, r.stdout + r.stderr)
    assert.ok(r.stderr.includes(path.join(runDir, 'lock')), r.stderr)
    assert.match(r.stderr, new RegExp(`pid ${h.p.pid}`))
    assert.match(r.stderr, /仍在/)
    assert.match(r.stderr, /測試用建置/)
    assert.match(r.stderr, /手動刪/)
    assert.ok(fs.existsSync(path.join(runDir, 'lock')), '鎖還在持有者手上')
    h.killAll()
  })

  test('持有者正常結束會放鎖，等待中的人接著拿到', async () => {
    const runDir = freshRun()
    const h = holder(runDir, '短暫持鎖', 2)
    await h.ready
    const r = acquire(runDir, '等待的人', 15)
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /等另一個/)
    assert.match(r.stdout, /GOT/)
    assert.ok(!fs.existsSync(path.join(runDir, 'lock')), '拿到的人結束後鎖也放掉了')
  })

  test('殘留鎖（持有者已不在）不自動收回：逾時退出、鎖原封不動、訊息寫明 pid 已不在與手動刪除', () => {
    const runDir = freshRun()
    fs.mkdirSync(path.join(runDir, 'lock'))
    fs.writeFileSync(path.join(runDir, 'lock', 'owner'), '99999 up.sh 實例 2（build=force）\n')
    const r = acquire(runDir, '想拿鎖的人', 1)
    assert.notEqual(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stderr, /pid 99999/)
    assert.match(r.stderr, /已不在/)
    assert.match(r.stderr, /up\.sh 實例 2/)
    assert.match(r.stderr, /手動刪/)
    assert.doesNotMatch(r.stdout + r.stderr, /收回/)
    assert.ok(fs.existsSync(path.join(runDir, 'lock', 'owner')), '殘留鎖與 owner 檔都還在')
  })

  test('殘留鎖的 owner 檔記了建置 PGID：訊息要人先用 pgrep -g 確認、kill -TERM 整組，再刪鎖', () => {
    const runDir = freshRun()
    fs.mkdirSync(path.join(runDir, 'lock'))
    fs.writeFileSync(path.join(runDir, 'lock', 'owner'), '99999 up.sh 實例 2（build=force）\nbuild-pgid 4242\n')
    const r = acquire(runDir, '想拿鎖的人', 1)
    assert.notEqual(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stderr, /pid 99999/)
    assert.match(r.stderr, /pgrep -g 4242/)
    assert.match(r.stderr, /kill -TERM -- -4242/)
    assert.ok(fs.existsSync(path.join(runDir, 'lock', 'owner')), '殘留鎖與 owner 檔都還在')
  })

  test('up.sh 碰到殘留鎖：逾時退出、零副作用', () => {
    const runDir = freshRun()
    fs.mkdirSync(path.join(runDir, 'lock'))
    fs.writeFileSync(path.join(runDir, 'lock', 'owner'), '99999 reset.sh 實例 1\n')
    const secrets = path.join(tmp, 'lock-secrets-stale')
    const r = spawnSync(path.join(HERE, 'up.sh'), [], {
      env: baseEnv(runDir, { INSTANCE: '1', TUTORIAL_SECRETS_DIR: secrets, TUTORIAL_LOCK_TIMEOUT: '1' }),
      encoding: 'utf8',
    })
    assert.notEqual(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stderr, /已不在/)
    assert.ok(fs.existsSync(path.join(runDir, 'lock', 'owner')), '沒有動殘留鎖')
    assert.ok(!fs.existsSync(secrets), '沒建 secrets')
    assert.ok(!fs.existsSync(path.join(runDir, '1')), '沒建 run 目錄')
  })

  test('up.sh（預設不建置）：別人持鎖（例如正在重建）時不會起程序、也不碰任何東西', async () => {
    const runDir = freshRun()
    const h = holder(runDir, 'up.sh --build 實例 0', 60)
    await h.ready
    const secrets = path.join(tmp, 'lock-secrets-up')
    const r = spawnSync(path.join(HERE, 'up.sh'), [], {
      env: baseEnv(runDir, { INSTANCE: '1', TUTORIAL_SECRETS_DIR: secrets, TUTORIAL_LOCK_TIMEOUT: '1' }),
      encoding: 'utf8',
    })
    assert.notEqual(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stderr, /up\.sh --build 實例 0/)
    assert.ok(!fs.existsSync(path.join(runDir, '1', 'app.pid')), '沒有起 app')
    assert.ok(!fs.existsSync(secrets), '還沒到 load_env（沒建 secrets）')
    h.killAll()
  })

  test('reset.sh：別人持鎖時在停程序、刪庫之前就退出', async () => {
    const runDir = freshRun()
    const h = holder(runDir, 'up.sh --update', 60)
    await h.ready
    const site = fakeBuiltSite(path.join(tmp, 'lock-fake-site'), runDir)
    fs.mkdirSync(path.join(runDir, '0'), { recursive: true })
    const pidFile = path.join(runDir, '0', 'worker.pid')
    fs.writeFileSync(pidFile, JSON.stringify({ kind: 'worker', pid: '1', pgid: '1', lstart: 'x', cwd: '/nowhere' }))
    const secrets = path.join(tmp, 'lock-secrets-reset')
    const r = spawnSync(path.join(HERE, 'reset.sh'), [], {
      env: baseEnv(runDir, { TUTORIAL_SITE_DIR: site, TUTORIAL_SECRETS_DIR: secrets, TUTORIAL_LOCK_TIMEOUT: '1' }),
      encoding: 'utf8',
    })
    assert.notEqual(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stderr, /up\.sh --update/)
    assert.ok(fs.existsSync(pidFile), '沒有進到 stop_proc（pid 檔原封不動）')
    assert.ok(!fs.existsSync(secrets), '還沒到 load_env（沒建 secrets）')
    h.killAll()
  })
})

// ── Review 第 3 次退回第 2 項：建置／換版本只能在沒有任何實例在跑時做；預設不建置 ─────────────────

describe('建置與換版本只在所有實例都停了才做', () => {
  const home = path.join(tmp, 'build-home')
  fs.mkdirSync(home, { recursive: true })
  const sock = path.join(tmp, 'build.sock')
  test('準備假的 docker socket', async () => {
    await fakeDockerSocket(sock)
  })
  let seq = 0
  const fresh = (name) => {
    const d = path.join(tmp, `build-${name}-${seq++}`)
    fs.mkdirSync(d, { recursive: true })
    return d
  }
  const run = (args, env) =>
    spawnSync(path.join(HERE, 'up.sh'), args, { env: { PATH: process.env.PATH, HOME: home, TUTORIAL_DOCKER_SOCK: sock, TUTORIAL_LOCK_TIMEOUT: '2', ...env }, encoding: 'utf8' })

  test('up.sh 預設不建置：沒有網站 checkout 就零副作用退出，提示先 down 全部實例再 up.sh --build', () => {
    const runDir = fresh('run')
    const site = path.join(tmp, 'build-no-site')
    const secrets = fresh('secrets-unused')
    fs.rmSync(secrets, { recursive: true })
    const r = run([], { TUTORIAL_RUN_DIR: runDir, TUTORIAL_SITE_DIR: site, TUTORIAL_SECRETS_DIR: secrets })
    assert.notEqual(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stderr, /down/)
    assert.match(r.stderr, /up\.sh --build/)
    assert.ok(!fs.existsSync(site), '沒有建 checkout')
    assert.ok(!fs.existsSync(secrets), '沒建 secrets')
    assert.ok(!fs.existsSync(path.join(runDir, 'lock')), '鎖放掉了')
  })

  test('up.sh 預設不建置：有 checkout 但 build mark 跟 HEAD 的 web tree 不同（上次建置沒完成）也拒絕', () => {
    const runDir = fresh('run')
    const site = fakeBuiltSite(fresh('site'), runDir)
    fs.writeFileSync(path.join(runDir, 'build-commit'), 'deadbeef\n')
    const secrets = path.join(tmp, 'build-secrets-stale-mark')
    const r = run([], { TUTORIAL_RUN_DIR: runDir, TUTORIAL_SITE_DIR: site, TUTORIAL_SECRETS_DIR: secrets })
    assert.notEqual(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stderr, /up\.sh --build/)
    assert.ok(!fs.existsSync(secrets), '沒建 secrets')
    assert.ok(!fs.existsSync(path.join(runDir, 'lock')), '鎖放掉了')
  })

  test('up.sh --build／--update：有任何實例在跑（stub 的 worker）就在持鎖後拒絕、零副作用', async () => {
    // stub：一個真的 node dist/worker.mjs 程序（自成 process group），用 proc-record 登記成實例 3 的 worker。
    const stubDir = fresh('stub')
    fs.mkdirSync(path.join(stubDir, 'dist'))
    fs.writeFileSync(path.join(stubDir, 'dist', 'worker.mjs'), 'setInterval(() => {}, 1000)\n')
    const stub = spawn('node', ['dist/worker.mjs'], { cwd: stubDir, stdio: 'ignore', detached: true })
    after(() => {
      try {
        process.kill(-stub.pid, 'SIGKILL')
      } catch {}
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const runDir = fresh('run')
    fs.mkdirSync(path.join(runDir, '3'))
    execFileSync('node', [path.join(HERE, 'safety.mjs'), 'proc-record', 'worker', String(stub.pid), path.join(runDir, '3', 'worker.pid'), stubDir])
    const site = path.join(tmp, 'build-no-site-2')
    for (const args of [['--build'], ['--update']]) {
      const secrets = path.join(tmp, `build-secrets-${args[0].slice(2)}`)
      const r = run(args, { TUTORIAL_RUN_DIR: runDir, TUTORIAL_SITE_DIR: site, TUTORIAL_SECRETS_DIR: secrets, INSTANCE: '0' })
      assert.notEqual(r.status, 0, args + r.stdout + r.stderr)
      assert.match(r.stderr, /實例 3/)
      assert.match(r.stderr, /down/)
      assert.ok(!fs.existsSync(site), `${args}：沒有建 checkout`)
      assert.ok(!fs.existsSync(secrets), `${args}：沒建 secrets`)
      assert.ok(!fs.existsSync(path.join(runDir, 'lock')), `${args}：鎖放掉了`)
    }
    assert.equal(stub.exitCode, null, 'stub 還活著（沒被送訊號）')
  })

  test('up.sh 被中斷時，還在跑的建置子程序會一起停掉，不會留下孤兒繼續改寫 .next', async () => {
    const runDir = fresh('run')
    const site = fakeBuiltSite(fresh('site'), runDir)
    const shim = fresh('shim')
    const pnpmPidFile = path.join(shim, 'pnpm.pid')
    fs.writeFileSync(path.join(shim, 'pnpm'), '#!/bin/sh\necho $$ > "$FAKE_PNPM_PIDFILE"\nexec sleep 60\n', { mode: 0o755 })
    const p = spawn('/bin/bash', ['-c', 'source "$1" && lock_acquire 建置 && ensure_build', '_', path.join(HERE, 'lib.sh')], {
      env: { PATH: `${shim}:${process.env.PATH}`, HOME: home, TUTORIAL_RUN_DIR: runDir, TUTORIAL_SITE_DIR: site, FAKE_PNPM_PIDFILE: pnpmPidFile },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    after(() => {
      try {
        process.kill(-p.pid, 'SIGKILL')
      } catch {}
    })
    const exited = new Promise((resolve) => p.on('exit', resolve))
    for (let i = 0; i < 50 && !fs.existsSync(pnpmPidFile); i++) await new Promise((resolve) => setTimeout(resolve, 100))
    assert.ok(fs.existsSync(pnpmPidFile), '假的 pnpm build 有起來')
    const pnpmPid = Number(fs.readFileSync(pnpmPidFile, 'utf8'))
    process.kill(p.pid, 'SIGTERM') // 只打 up.sh 本身（模擬被 kill），不打建置
    await exited
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.throws(() => process.kill(pnpmPid, 0), /ESRCH/, '建置子程序也停了')
    assert.ok(!fs.existsSync(path.join(runDir, 'lock')), '鎖放掉了')
    assert.ok(!fs.existsSync(path.join(runDir, 'build-commit')), '沒完成的建置不會留下 build mark')
  })
  test('建置主程序被 kill -9、子程序還在：放鎖前會等子程序結束（或把它整組停掉），不留下孤兒', async () => {
    const runDir = fresh('run')
    const site = fakeBuiltSite(fresh('site'), runDir)
    const shim = fresh('shim')
    const leaderPidFile = path.join(shim, 'pnpm.pid')
    const childPidFile = path.join(shim, 'child.pid')
    // 假的 pnpm build：自己是 leader，再生一個子程序（模擬 next build 的 worker），然後等它。
    fs.writeFileSync(path.join(shim, 'pnpm'), '#!/bin/sh\necho $$ > "$FAKE_PNPM_PIDFILE"\nsleep 60 &\necho $! > "$FAKE_CHILD_PIDFILE"\nwait\n', { mode: 0o755 })
    const p = spawn('/bin/bash', ['-c', 'source "$1" && lock_acquire 建置 && ensure_build', '_', path.join(HERE, 'lib.sh')], {
      env: { PATH: `${shim}:${process.env.PATH}`, HOME: home, TUTORIAL_RUN_DIR: runDir, TUTORIAL_SITE_DIR: site, FAKE_PNPM_PIDFILE: leaderPidFile, FAKE_CHILD_PIDFILE: childPidFile },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    after(() => {
      try {
        process.kill(-p.pid, 'SIGKILL')
      } catch {}
    })
    let err = ''
    p.stderr.on('data', (d) => (err += d))
    const exited = new Promise((resolve) => p.on('exit', resolve))
    for (let i = 0; i < 50 && !fs.existsSync(childPidFile); i++) await new Promise((resolve) => setTimeout(resolve, 100))
    assert.ok(fs.existsSync(childPidFile), '假建置的子程序有起來')
    const leaderPid = Number(fs.readFileSync(leaderPidFile, 'utf8'))
    const childPid = Number(fs.readFileSync(childPidFile, 'utf8'))
    after(() => {
      try {
        process.kill(childPid, 'SIGKILL')
      } catch {}
    })
    process.kill(leaderPid, 'SIGKILL') // 只殺建置的 leader；子程序本來會活著
    const status = await exited
    assert.notEqual(status, 0, `建置被殺應該算失敗：${err}`)
    assert.throws(() => process.kill(childPid, 0), /ESRCH/, '放鎖前子程序已經結束或被停掉')
    assert.ok(!fs.existsSync(path.join(runDir, 'lock')), '鎖放掉了')
    assert.ok(!fs.existsSync(path.join(runDir, 'build-commit')), '沒完成的建置不會留下 build mark')
  })
})

// ── Review 第 3 次退回第 3 項：reset.sh 等到鎖之後要重做檢查 ─────────────────────────────────

describe('reset.sh 拿到鎖之後重跑檢查', () => {
  const home = path.join(tmp, 'recheck-home')
  fs.mkdirSync(home, { recursive: true })
  const sock = path.join(tmp, 'recheck.sock')
  test('準備假的 docker socket', async () => {
    await fakeDockerSocket(sock)
  })

  test('等鎖期間建置產物不見了（stub）：拿到鎖後重檢不過 → 放鎖、零副作用退出', async () => {
    const runDir = path.join(tmp, 'recheck-run')
    const site = fakeBuiltSite(path.join(tmp, 'recheck-site'), runDir)
    const env = { PATH: process.env.PATH, HOME: home, TUTORIAL_RUN_DIR: runDir, TUTORIAL_DOCKER_SOCK: sock, TUTORIAL_SITE_DIR: site }
    const lib = path.join(HERE, 'lib.sh')
    // 別人持鎖 4 秒。
    const h = spawn('/bin/bash', ['-c', 'source "$1" && lock_acquire 別人 && echo HELD && sleep 4', '_', lib], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    after(() => {
      try {
        process.kill(-h.pid, 'SIGKILL')
      } catch {}
    })
    await new Promise((resolve, reject) => {
      let out = ''
      h.stdout.on('data', (d) => {
        out += d
        if (out.includes('HELD')) resolve()
      })
      h.on('exit', (c) => reject(new Error(`holder 先結束了（${c}）`)))
    })
    fs.mkdirSync(path.join(runDir, '0'), { recursive: true })
    const pidFile = path.join(runDir, '0', 'worker.pid')
    fs.writeFileSync(pidFile, JSON.stringify({ kind: 'worker', pid: '1', pgid: '1', lstart: 'x', cwd: '/nowhere' }))
    const secrets = path.join(tmp, 'recheck-secrets')
    const r = spawn(path.join(HERE, 'reset.sh'), [], { env: { ...env, TUTORIAL_SECRETS_DIR: secrets, TUTORIAL_LOCK_TIMEOUT: '20' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    r.stdout.on('data', (d) => (out += d))
    r.stderr.on('data', (d) => (err += d))
    const exited = new Promise((resolve) => r.on('exit', resolve))
    // 等 reset.sh 過了第一輪檢查、正在等鎖，才把建置產物拿掉（模擬別人在鎖裡把建置弄壞／換掉）。
    for (let i = 0; i < 100 && !out.includes('等另一個'); i++) await new Promise((resolve) => setTimeout(resolve, 100))
    assert.match(out, /等另一個/, `reset.sh 沒有在等鎖：${out}${err}`)
    fs.rmSync(path.join(site, 'web', '.next', 'BUILD_ID'))
    const status = await exited
    assert.notEqual(status, 0, out + err)
    assert.match(err, /建置/)
    assert.ok(fs.existsSync(pidFile), '沒有進到 stop_proc（pid 檔原封不動）')
    assert.ok(!fs.existsSync(secrets), '沒建 secrets')
    assert.ok(!fs.existsSync(path.join(runDir, 'lock')), '鎖放掉了')
  })
})
