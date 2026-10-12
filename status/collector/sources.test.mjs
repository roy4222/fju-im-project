// 各來源的純函式：遮蔽規則、/api/health 判定、Access 守門判定、deploy_log 與備份紀錄解析。
import { describe, expect, it } from 'vitest'
import { judgeAccessGuard, judgeHealthBody, lastResults, siteHealth } from './lib/health.mjs'
import { findLeaks, scrubIp } from './lib/redact.mjs'
import { lastBackupRecord, parseDeployLog } from './lib/vm.mjs'

describe('遮蔽（同 summarize-night.sh 規則＋IP）', () => {
  it.each([
    ['someone@example.com', 'Email'],
    ['ghp_' + 'a'.repeat(30), 'token'],
    ['dp.st.prd.' + 'x'.repeat(30), 'token'],
    ['eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abcdefgh', 'token'],
    ['password: hunter2hunter2', '密碼'],
    ['連到 10.0.0.12:5432', 'IP'],
  ])('%s → %s', (text, kind) => {
    expect(findLeaks(text)).toContain(kind)
  })

  it('正常內容不誤判：digest、版本號、佔位密碼', () => {
    expect(findLeaks('ghcr.io/roy4222/fju-web@sha256:abc 16.3.8 token: ${DOPPLER_TOKEN} 2026-10-12T10:00:00Z')).toEqual([])
  })

  it('scrubIp 把 IPv4 換掉', () => {
    expect(scrubIp('connect ECONNREFUSED 192.168.1.20:443')).toBe('connect ECONNREFUSED [IP]:443')
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
