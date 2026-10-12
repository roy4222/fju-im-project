// 各來源的純函式：遮蔽規則、/api/health 判定、Access 守門判定、deploy_log 與備份紀錄解析。
import { describe, expect, it } from 'vitest'
import { judgeAccessGuard, judgeHealthBody, lastResults, siteHealth } from './lib/health.mjs'
import { findLeaks, findSensitiveKeys, scrubIp } from './lib/redact.mjs'
import { lastBackupRecord, parseDeployLog } from './lib/vm.mjs'

describe('遮蔽（同 summarize-night.sh 規則＋IP）', () => {
  it.each([
    ['someone@example.com', 'Email'],
    ['ghp_' + 'a'.repeat(30), 'token'],
    ['dp.st.prd.' + 'x'.repeat(30), 'token'],
    ['eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abcdefgh', 'token'],
    ['password: hunter2hunter2', '密碼'],
    ['連到 10.0.0.12:5432', 'IP'],
    ['dial tcp [2a01:4f8:c17:1a2b::1]:443', 'IP'],
    ['2001:0db8:0000:0000:0000:ff00:0042:8329', 'IP'],
    ['postgres://fju_app:hunter2@db:5432/fju', '連線字串'],
    ['redis://:pw@cache:6379', '連線字串'],
  ])('%s → %s', (text, kind) => {
    expect(findLeaks(text)).toContain(kind)
  })

  it('正常內容不誤判：digest、版本號、佔位密碼', () => {
    expect(findLeaks('ghcr.io/roy4222/fju-web@sha256:abc 16.3.8 token: ${DOPPLER_TOKEN} 2026-10-12T10:00:00Z')).toEqual([])
    expect(findLeaks('2026-10-12T22:00:00+0800 10:00:00.123Z [STATUS] (502) == 200 sha256:deadbeef')).toEqual([])
  })

  it('敏感鍵名：有值才算；鍵名清單（字串值）、佔位、空字串、布林不算', () => {
    expect(findSensitiveKeys({ a: { password: 'x1' }, b: [{ DB_PASSWORD: 'y' }], c: { apiKey: 123 } })).toEqual([
      'a.password',
      'b[0].DB_PASSWORD',
      'c.apiKey',
    ])
    expect(
      findSensitiveKeys({ missing: ['E2E_ADMIN_PASSWORD'], token: '${DOPPLER_TOKEN}', secret: '', hasToken: false, bypass: 'x' }),
    ).toEqual([])
  })

  it('一般網址與 host:port 不算連線字串', () => {
    expect(findLeaks('http://example.com:8080/a https://github.com/x/runs/1')).toEqual([])
  })

  it('scrubIp 把 IPv4 換掉', () => {
    expect(scrubIp('connect ECONNREFUSED 192.168.1.20:443')).toBe('connect ECONNREFUSED [IP]:443')
    expect(scrubIp('dial tcp [2a01:4f8::1]:443')).toBe('dial tcp [[IP]]:443')
  })
})

describe('/api/health 判定（與 health-cron.yml 的 CHECK 同規則）', () => {
  const now = new Date('2026-10-12T10:00:00Z')
  const body = (tickSecondsAgo, extra = {}) => ({
    ok: true,
    commit: 'abc12345',
    worker: { lastTickAt: new Date(now.getTime() - tickSecondsAgo * 1000).toISOString() },
    ...extra,
  })
  it('恰好 300 秒仍算活著、301 秒不算', () => {
    expect(judgeHealthBody(body(300), now)).toBeNull()
    expect(judgeHealthBody(body(301), now)).toContain('超過 300 秒')
  })
  it('ok 不是 true、commit 空、沒有心跳都不算', () => {
    expect(judgeHealthBody(body(1, { ok: false }), now)).not.toBeNull()
    expect(judgeHealthBody(body(1, { commit: '' }), now)).not.toBeNull()
    expect(judgeHealthBody({ ok: true, commit: 'x', worker: { lastTickAt: null } }, now)).not.toBeNull()
  })
  it('last6 新到舊、最近一次失敗就不 ok', () => {
    const status = {
      results: [true, true, true, true, true, true, false].map((s, i) => ({
        success: s,
        timestamp: `t${i}`,
        conditionResults: [{ condition: '[STATUS] (502) == 200', success: s }],
      })),
    }
    expect(lastResults(status).map((r) => r.timestamp)).toEqual(['t6', 't5', 't4', 't3', 't2', 't1'])
    const h = siteHealth(status, { commit: 'abc', reason: null })
    expect(h).toMatchObject({ ok: false, checkedAt: 't6', last6: [false, true, true, true, true, true] })
    expect(h.reason).toContain('[STATUS] (502) == 200')
  })
  it('Gatus 全過但直接打發現心跳停了：不 ok', () => {
    const status = { results: [{ success: true, timestamp: 't' }] }
    expect(siteHealth(status, { commit: 'abc', reason: 'worker 心跳 400 秒前' })).toMatchObject({ ok: false, reason: 'worker 心跳 400 秒前' })
  })
})

describe('Access 守門判定', () => {
  const team = 'fake.cloudflareaccess.com'
  it('302 且指到 team 的 /cdn-cgi/access/login 才算擋住', () => {
    expect(judgeAccessGuard({ status: 302, location: `https://${team}/cdn-cgi/access/login/h` }, team)).toBe(true)
    expect(judgeAccessGuard({ status: 200, location: null }, team)).toBe(false)
    expect(judgeAccessGuard({ status: 302, location: 'https://evil.example/cdn-cgi/access/login' }, team)).toBe(false)
    expect(judgeAccessGuard({ status: 302, location: `https://other.cloudflareaccess.com/cdn-cgi/access/login` }, team)).toBe(false)
    expect(judgeAccessGuard({ status: 302, location: `http://${team}/cdn-cgi/access/login` }, team)).toBe(false)
  })
  it('沒設 team 時接受任何 *.cloudflareaccess.com', () => {
    expect(judgeAccessGuard({ status: 302, location: 'https://x.cloudflareaccess.com/cdn-cgi/access/login/h' }, null)).toBe(true)
  })
})

describe('VM 紀錄解析', () => {
  it('deploy_log 取最後 5 筆、新到舊；只有 deployed／rolled-back 帶 digest；原因欄不帶出來', () => {
    const text = [
      '2026-10-01T00:00:00Z\tdeployed\tt1\tfull\tsha256:1\tunchanged',
      '2026-10-02T00:00:00Z\te2e-seed-failed\tt2',
      '2026-10-03T00:00:00Z\trollback-start\tt3\thealth-failed',
      '2026-10-04T00:00:00Z\trollback-done\tghcr.io/x/web:t2\thealthy\thealth-failed',
      '2026-10-05T00:00:00Z\trolled-back\tt2\tfull\tsha256:2\tunchanged',
      '2026-10-06T00:00:00Z\tdeployed\tt4\tfull\tsha256:4\t0012',
      '',
    ].join('\n')
    const rows = parseDeployLog(text)
    expect(rows.map((r) => r.event)).toEqual(['deployed', 'rolled-back', 'rollback-done', 'rollback-start', 'e2e-seed-failed'])
    expect(rows[0]).toEqual({ at: '2026-10-06T00:00:00Z', event: 'deployed', tag: 't4', digest: 'sha256:4' })
    expect(rows[3]).toEqual({ at: '2026-10-03T00:00:00Z', event: 'rollback-start', tag: 't3', digest: null })
    expect(JSON.stringify(rows)).not.toContain('health-failed')
  })
  it('備份紀錄取最後一筆 kind=backup，失敗也算（ok:false）', () => {
    const text = [
      JSON.stringify({ kind: 'backup', status: 'ok', finished_at: 'a' }),
      JSON.stringify({ kind: 'backup', status: 'failed', finished_at: 'b', error: '取得 Doppler 秘密失敗' }),
      JSON.stringify({ kind: 'drill', status: 'ok', finished_at: 'c' }),
    ].join('\n')
    expect(lastBackupRecord(text)).toEqual({ at: 'b', ok: false })
    expect(lastBackupRecord('')).toBeNull()
  })
})

// 第二次 Review 的漏攔與 15 種以上變形：每種都要被黑名單抓到（整檔拒寫），或根本不在白名單裡（collect.test.mjs）。
describe('遮蔽變形（Review 第二輪）', () => {
  it.each([
    ['postgresql://db/fju?user=app&password=x', '連線字串'], // query 參數、1 個字元也算
    ['postgresql://db/fju?user=app&%70assword=FAKEPASS123', '連線字串'], // 鍵名 URL 編碼
    ['POSTGRESQL://DB/FJU?USER=APP&PASSWORD=FAKEPASS123', '連線字串'], // 全大寫
    ['postgres://:FAKEPASS123@db:5432/fju', '連線字串'], // userinfo 只有密碼
    ['postgres://app%3AFAKEPASS123@db/fju', '連線字串'], // userinfo 的冒號被編碼
    ['mysql://db/x?passwd=FAKEPASS123&sslmode=require', '連線字串'],
    ['mongodb+srv://db.example.net/x?authSource=admin&apiKey=FAKEPASS123', '連線字串'],
    ['https://api.example.net/v1?access_token=FAKEPASS123', '連線字串'],
    ['https://api.example.net/v1?key=FAKEPASS123', '連線字串'],
    ['password%3DFAKEPASS123', '密碼'], // 整段 URL 編碼的 password=
    ['PGPASSWORD=FAKEPASS123', '密碼'],
    ['apiKey=FAKEPASS123', '密碼'],
    ['api_key: FAKEPASS123', '密碼'],
    ['Authorization: Bearer FAKEPASS123FAKEPASS', 'token'],
    ['authorization=Basic RkFLRVBBU1MxMjM6RkFLRVBBU1M=', 'token'],
    ['Cookie: session=FAKEPASS123', '密碼'],
    ['set-cookie: CF_Authorization=FAKEPASS123', '密碼'],
    ['secret_key = FAKEPASS123', '密碼'],
    ['密碼：FAKEPASS123', '密碼'],
    ['AKIAIOSFODNN7EXAMPLE', 'token'],
  ])('%s → %s', (text, kind) => {
    expect(findLeaks(text)).toContain(kind)
  })

  it('JSON 文字裡的連線字串也抓得到（值被引號包住）', () => {
    expect(findLeaks(JSON.stringify({ a: 'postgresql://db/fju?user=app&password=x' }))).toContain('連線字串')
    expect(findLeaks(JSON.stringify({ a: 'postgres://:FAKEPASS123@db/fju' }))).toContain('連線字串')
  })

  it('不帶密碼的網址與連線字串不誤判', () => {
    expect(findLeaks('postgresql://db:5432/fju?sslmode=require&application_name=fju')).toEqual([])
    expect(findLeaks('https://github.com/x/actions/runs/11/attempts/2 ghcr.io/roy4222/fju-web:main')).toEqual([])
    // ssh://git@github.com/… 的 userinfo 長得像 email，照 summarize-night.sh 的規則本來就算命中（保守）
    expect(findLeaks('ssh://git@github.com/x/y.git')).toEqual(['Email'])
    expect(findLeaks('postgres://app@db/fju?password=')).toEqual([]) // 空值不算
    expect(findLeaks('https://x.example/cdn-cgi/access/login/h?kid=x')).toEqual([])
  })

  it('敏感鍵底下的容器（陣列、物件）有實值就算命中，路徑停在敏感鍵', () => {
    expect(findSensitiveKeys({ token: ['FAKEPASS123'] })).toEqual(['token'])
    expect(findSensitiveKeys({ secret: { value: 'FAKEPASS123' } })).toEqual(['secret'])
    expect(findSensitiveKeys({ a: { credentials: [{ user: 'app', pass: 'FAKEPASS123' }] } })).toEqual(['a.credentials'])
    expect(findSensitiveKeys({ secret: { nested: { deeper: 42 } } })).toEqual(['secret'])
  })

  it('敏感鍵名的各種寫法：大小寫、底線、連字號、HTTP header、URL 編碼的鍵名、數字型密碼、Base64 看起來像 token', () => {
    for (const obj of [
      { PGPASSWORD: 'FAKEPASS123' },
      { apiKey: 'FAKEPASS123' },
      { 'api-key': 'FAKEPASS123' },
      { API_KEY: 'FAKEPASS123' },
      { authorization: 'Bearer FAKEPASS123' },
      { Authorization: 'Basic RkFLRQ==' },
      { cookie: 'session=FAKEPASS123' },
      { 'Set-Cookie': 'CF_Authorization=FAKEPASS123' },
      { password: 123456 },
      { pin_pwd: 1234 },
      { db_pass: 'FAKEPASS123' },
      { passphrase: 'FAKEPASS123' },
      { client_secret: 'FAKEPASS123' },
      { private_key: '-----BEGIN RSA PRIVATE KEY-----' },
      { '%70assword': 'FAKEPASS123' },
      { token: 'QUtJQUlPU0ZPRE5ON0VYQU1QTEU=' },
      { access_token: 'FAKEPASS123' },
    ]) {
      expect(findSensitiveKeys(obj), JSON.stringify(Object.keys(obj))).toHaveLength(1)
    }
  })

  it('敏感鍵底下沒有實值（空容器、佔位、布林、null）不算', () => {
    expect(findSensitiveKeys({ token: ['${DOPPLER_TOKEN}'], secret: {}, password: null, apiKey: { enabled: false }, cookie: [] })).toEqual([])
    expect(findSensitiveKeys({ missing: ['E2E_ADMIN_PASSWORD', 'DOPPLER_TOKEN'], forbiddenPresent: ['E2E_ADMIN_EMAIL'] })).toEqual([])
  })
})
