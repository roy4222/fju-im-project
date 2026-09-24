import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 票 3b（#244）：E2E 測試管理員「正式站永遠不建」的腳本層防呆。不需要資料庫。
 *
 * DATABASE_URL_OWNER 故意指到一個連不上的位址：如果腳本在檢查站台之前就去連資料庫，
 * 錯誤訊息會是連線錯誤而不是「拒絕執行」——這樣就能證明它是**先**擋站台。
 */

const repoRoot = path.join(import.meta.dirname, '..', '..', '..')
const webRoot = path.join(repoRoot, 'web')

function runSeed(site: string | undefined) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL_OWNER: 'postgres://nobody:nothing@127.0.0.1:1/none',
    E2E_ADMIN_EMAIL: 'e2e@example.test',
    E2E_ADMIN_PASSWORD: 'long-enough-password-123',
  }
  if (site === undefined) delete env.FJU_SITE
  else env.FJU_SITE = site
  return spawnSync('node', ['scripts/seed-e2e.mjs'], { cwd: webRoot, encoding: 'utf8', env, timeout: 10_000 })
}

describe('seed-e2e.mjs：只在測試站動手', () => {
  for (const site of ['prod', 'production', 'stg', '', undefined]) {
    it(`FJU_SITE=${site === undefined ? '（沒設）' : `「${site}」`} → 連資料庫之前就拒絕`, () => {
      const r = runSeed(site)
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('拒絕執行')
      expect(r.stderr).not.toMatch(/ECONNREFUSED|connect/i)
    })
  }
})

describe('部署與映像', () => {
  it('映像裡有 seed-e2e.mjs（跟 seed-a1 放在一起，共用 production 依賴）', () => {
    const dockerfile = fs.readFileSync(path.join(webRoot, 'Dockerfile'), 'utf8')
    expect(dockerfile).toMatch(/COPY .*\/repo\/web\/scripts\/seed-e2e\.mjs \.\/migrate\/web\/scripts\/seed-e2e\.mjs/)
  })

  it('deploy.sh 只在 test 站呼叫 seed-e2e（寫死的站台判斷在呼叫之前）', () => {
    const deploy = fs.readFileSync(path.join(repoRoot, 'ops/deploy.sh'), 'utf8')
    const fn = deploy.slice(deploy.indexOf('seed_e2e_admin() {'), deploy.indexOf('# ── 4. 先跑 migration'))
    expect(fn).toContain('if [ "$SITE" != test ]; then')
    expect(fn.indexOf('"$SITE" != test')).toBeLessThan(fn.indexOf('seed-e2e.mjs'))
    // 值只以名稱轉交，不在指令列。
    expect(fn).toContain('-e E2E_ADMIN_EMAIL -e E2E_ADMIN_PASSWORD -e FJU_SITE')
    expect(fn).not.toMatch(/-e E2E_ADMIN_(EMAIL|PASSWORD)=/)
  })
})
