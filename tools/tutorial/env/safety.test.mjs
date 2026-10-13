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
  probeProcess,
  validateAccounts,
} from './safety.mjs'

const HERE = import.meta.dirname
const requireWeb = createRequire(path.join(HERE, '..', '..', '..', 'web', 'package.json'))
const { parse } = createRequire(requireWeb.resolve('pg'))('pg-connection-string')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tutorial-safety-'))
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

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
  const server = net.createServer()
  after(() => server.close())

  test('本機 socket 可以', async () => {
    await new Promise((resolve) => server.listen(sock, resolve))
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
  const server = net.createServer()
  after(() => server.close())
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
    await new Promise((resolve) => server.listen(sock, resolve))
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
