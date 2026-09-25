import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 票 32（#281）：測試站示範資料「正式站永遠不建」的腳本層防呆。不需要資料庫。
 *
 * DATABASE_URL_OWNER 故意指到一個連不上的位址：如果腳本在檢查站台之前就去連資料庫，
 * 錯誤訊息會是連線錯誤而不是「拒絕執行」——這樣就能證明它是**先**擋站台（建立與 --remove 都一樣）。
 */

const repoRoot = path.join(import.meta.dirname, '..', '..', '..')
const webRoot = path.join(repoRoot, 'web')

function runSeed(site: string | undefined, args: string[] = []) {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL_OWNER: 'postgres://nobody:nothing@127.0.0.1:1/none' }
  if (site === undefined) delete env.FJU_SITE
  else env.FJU_SITE = site
  return spawnSync('node', ['scripts/seed-demo.mjs', ...args], { cwd: webRoot, encoding: 'utf8', env, timeout: 10_000 })
}

describe('seed-demo.mjs：只在測試站動手', () => {
  for (const args of [[], ['--remove']]) {
    for (const site of ['prod', 'production', 'stg', '', undefined]) {
      it(`${args.join(' ') || '建立'}：FJU_SITE=${site === undefined ? '（沒設）' : `「${site}」`} → 連資料庫之前就拒絕`, () => {
        const r = runSeed(site, args)
        expect(r.status).toBe(1)
        expect(r.stderr).toContain('拒絕執行')
        expect(r.stderr).not.toMatch(/ECONNREFUSED|connect/i)
      })
    }
  }

  it('不認得的參數也拒絕（不會把打錯的 --remvoe 當成「建立」）', () => {
    const r = runSeed('test', ['--remvoe'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('不認得的參數')
    expect(r.stderr).not.toMatch(/ECONNREFUSED|connect/i)
  })
})

describe('部署與映像', () => {
  it('映像裡有 seed-demo.mjs 與 demo/（內容與封面圖），放在 migrate 底下、不進 web/public', () => {
    const dockerfile = fs.readFileSync(path.join(webRoot, 'Dockerfile'), 'utf8')
    expect(dockerfile).toMatch(/COPY .*\/repo\/web\/scripts\/seed-demo\.mjs \.\/migrate\/web\/scripts\/seed-demo\.mjs/)
    expect(dockerfile).toMatch(/COPY .*\/repo\/web\/scripts\/demo \.\/migrate\/web\/scripts\/demo/)
    expect(fs.existsSync(path.join(webRoot, 'public', 'placeholder'))).toBe(false)
  })

  it('deploy.sh 只在 test 站呼叫 seed-demo（站台判斷在呼叫之前），demo-seed.off 在就略過', () => {
    const deploy = fs.readFileSync(path.join(repoRoot, 'ops/deploy.sh'), 'utf8')
    const fn = deploy.slice(deploy.indexOf('seed_demo_data() {'), deploy.indexOf('# ── 4. 先跑 migration'))
    expect(fn).toContain('if [ "$SITE" != test ]; then')
    expect(fn.indexOf('"$SITE" != test')).toBeLessThan(fn.indexOf('seed-demo.mjs'))
    expect(fn.indexOf('$DEMO_SEED_OFF')).toBeLessThan(fn.indexOf('seed-demo.mjs'))
    // 封面與附件寫進這一站的附件目錄（跟 app 掛的是同一個）。
    expect(fn).toContain('-v "$SITE_ROOT/files:$FILES_ROOT"')
  })

  it('ops/seed-demo.sh 在身分與秘密之前就擋掉非 test 站', () => {
    const script = fs.readFileSync(path.join(repoRoot, 'ops/seed-demo.sh'), 'utf8')
    const refuse = script.indexOf('if [ "$SITE" != test ]; then')
    expect(refuse).toBeGreaterThan(0)
    expect(refuse).toBeLessThan(script.indexOf('require_deploy_user'))
    expect(refuse).toBeLessThan(script.indexOf('site_exec_with_secrets'))
  })
})
