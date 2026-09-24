import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'

const exec = promisify(execFile)
const repoRoot = path.join(import.meta.dirname, '..', '..', '..')
const deploySh = path.join(repoRoot, 'ops/deploy.sh')
const checkHealth = path.join(repoRoot, 'ops/check-health.mjs')

/**
 * S00-10：部署流程只准演練。
 *
 * 這一票**不會**真的部署、不 SSH、不碰線上原型。要證明的是：
 * dry-run 把契約 05 §3 的七個步驟照順序印出來、預設就是 dry-run，
 * 以及健康判定的比對邏輯真的會擋下不符的版本。
 */

async function dryRun(args: string[]): Promise<string> {
  const deployDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fju-deploy-'))
  try {
    const { stdout } = await exec('bash', [deploySh, '--site', 'test', ...args], {
      cwd: repoRoot,
      env: { ...process.env, DEPLOY_DIR: deployDir },
    })
    return stdout
  } finally {
    fs.rmSync(deployDir, { recursive: true, force: true })
  }
}

describe('ops/deploy.sh --dry-run', () => {
  it('不帶旗標時預設就是演練，什麼都不執行', async () => {
    const out = await dryRun(['abc123'])
    expect(out).toContain('這是演練，什麼都沒有執行')
    expect(out).not.toContain('[execute]')
  })

  it('照契約 05 §3 的順序印出七個步驟', async () => {
    const out = await dryRun(['abc123'])
    const order = [
      '1/7 取得部署鎖',
      '2/7 記下目前版本',
      '3/7 拉新映像',
      '4/7 用新映像跑 migration',
      '5/7 啟動新版 app 與 worker',
      '6/7 健康判定',
      '7/7 寫 deploy_log',
    ]
    let cursor = -1
    for (const marker of order) {
      const at = out.indexOf(marker)
      expect(at, `輸出裡找不到「${marker}」`).toBeGreaterThan(cursor)
      cursor = at
    }
  })

  it('migration 排在啟動新版之前（失敗即中止，舊 app 繼續跑）', async () => {
    const out = await dryRun(['abc123'])
    expect(out.indexOf('run --rm migrate')).toBeLessThan(out.indexOf('up -d --no-deps app worker'))
  })

  it('沒有帶 --expect-worker 時用有限健康條件', async () => {
    const out = await dryRun(['abc123'])
    expect(out).toContain('有限四項')
    expect(out).toContain('worker 欄必須是 null')
    expect(out).toContain('limited-no-worker')
  })

  it('帶 --expect-worker 時改用完整六項', async () => {
    const out = await dryRun(['abc123', '--expect-worker'])
    expect(out).toContain('完整六項')
    expect(out).toContain('worker.lastTickAt')
  })

  it('沒給 tag 就拒絕', async () => {
    await expect(dryRun([])).rejects.toThrow()
  })

  it('tag 會組成要部署的映像參照，不是只拿去比對', async () => {
    const out = await dryRun(['abc123'])
    expect(out).toContain('ghcr.io/roy4222/fju-web:abc123')
  })

  it('健康判定會比對 digest 與 schemaVersion，不是只比 commit', async () => {
    const out = await dryRun(['abc123'])
    expect(out).toContain('imageDigest=<pull 到的 digest>')
    expect(out).toContain('schemaVersion=<migrate 輸出>')
  })
})

describe('ops/deploy.sh 兩站（2026-09-24）', () => {
  it('沒給 --site 就拒絕，不會默默部署到某一站', async () => {
    await expect(exec('bash', [deploySh, 'abc123'], { cwd: repoRoot })).rejects.toThrow(/缺少 --site/)
  })

  it('--site 只收 test 或 prod', async () => {
    await expect(exec('bash', [deploySh, '--site', 'staging', 'abc123'], { cwd: repoRoot })).rejects.toThrow(
      /test 或 prod/,
    )
  })

  it('test 對應 fju-test、stg、test.fju.roy422.dev；prod 對應 fju-prod、prd、fju.roy422.dev', async () => {
    const test = await dryRun(['abc123'])
    expect(test).toContain('Compose project fju-test')
    expect(test).toContain('Doppler stg')
    expect(test).toContain('https://test.fju.roy422.dev/api/health')

    const { stdout: prod } = await exec('bash', [deploySh, '--site', 'prod', 'abc123'], {
      cwd: repoRoot,
      env: { ...process.env, DEPLOY_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'fju-deploy-')) },
    })
    expect(prod).toContain('Compose project fju-prod')
    expect(prod).toContain('Doppler prd')
    expect(prod).toContain('https://fju.roy422.dev/api/health')
  })

  it('E2E 測試管理員：test 站演練會列出 seed-e2e，prod 站只說一律不建', async () => {
    const test = await dryRun(['abc123'])
    expect(test).toContain('migrate node migrate/web/scripts/seed-e2e.mjs')

    const { stdout: prod } = await exec('bash', [deploySh, '--site', 'prod', 'abc123'], {
      cwd: repoRoot,
      env: { ...process.env, DEPLOY_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'fju-deploy-')) },
    })
    expect(prod).not.toContain('seed-e2e')
    expect(prod).toContain('E2E 測試帳號：正式站一律不建')
  })

  it('演練不需要 Doppler token，也不碰 /srv/fju（CI 的 cd.yml 也是這樣跑）', async () => {
    const out = await dryRun(['abc123'])
    expect(out).toContain('doppler run --no-fallback')
    expect(out).toContain('這是演練，什麼都沒有執行')
  })

  it('--rollback 演練：不跑 migrate、健康判定不比 schemaVersion、記 rolled-back', async () => {
    const out = await dryRun(['oldtag', '--rollback'])
    expect(out).toContain('4/7 略過 migration')
    expect(out).not.toContain('run --rm migrate')
    expect(out).toContain('schemaVersion 不比對')
    expect(out).toContain('rolled-back')
  })

  it('tag 只收 docker tag 合法的字元', async () => {
    await expect(dryRun(['abc;rm -rf /'])).rejects.toThrow(/tag 格式不對/)
  })
})

describe('ops/deploy.sh 的失敗與回滾路徑（讀腳本本體）', () => {
  const source = fs.readFileSync(deploySh, 'utf8')

  it('APP_IMAGE 由 tag 組出來並 export 給 Compose', () => {
    expect(source).toMatch(/APP_IMAGE="\$IMAGE_REPO:\$TAG"/)
    expect(source).toMatch(/export APP_IMAGE/)
  })

  it('previous_tag 存的是映像參照與 digest，不是只有一個名字', () => {
    expect(source).toContain('PREVIOUS_APP_IMAGE=')
    expect(source).toContain('PREVIOUS_IMAGE_DIGEST=')
  })

  it('回滾會把 APP_IMAGE 換回前一版再 up，而不是原地重啟', () => {
    const rollback = source.slice(source.indexOf('compensate() {'))
    expect(rollback).toContain('APP_IMAGE="$PREVIOUS_APP_IMAGE"')
    expect(rollback).toMatch(/export APP_IMAGE IMAGE_DIGEST/)
    // --no-deps：不能讓 compose 跟著 depends_on 把舊映像的 migrator 帶起來（R5）。
    expect(rollback).toMatch(/\$COMPOSE up -d --no-deps app worker/)
  })

  it('啟動失敗與健康失敗走同一條補償流程（R4）', () => {
    expect(source).toMatch(/compensate 'start-failed'/)
    expect(source).toMatch(/compensate 'health-failed'/)
    expect(source).toMatch(/compensate 'postgres-start-failed'/)
    // 這兩行都必須用 if 攔下來，否則 set -e 會在補償之前就把腳本帶走。
    expect(source).toMatch(/if ! \$COMPOSE up -d --no-deps app worker; then/)
  })

  it('回滾後會重跑健康判定，並分別記 healthy／unhealthy', () => {
    expect(source).toContain('rollback-done')
    expect(source).toContain('healthy')
    expect(source).toContain('unhealthy')
  })

  it('第一次部署沒有前一版時明講，不假裝回滾成功', () => {
    expect(source).toContain('rollback-skipped')
    expect(source).toContain('沒有可回滾的版本')
  })

  it('imageDigest 由部署腳本帶進容器（build 時烤不進去）', () => {
    expect(source).toMatch(/export IMAGE_DIGEST/)
    const compose = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8')
    const parsed = YAML.parse(compose) as {
      services: Record<string, { environment?: Record<string, string> } | undefined>
    }
    // Compose 把它留成待展開的變數；deploy.sh export 之後才有值。
    expect(parsed.services.app?.environment?.IMAGE_DIGEST).toBe('${IMAGE_DIGEST:-}')
    expect(parsed.services.worker?.environment?.IMAGE_DIGEST).toBe('${IMAGE_DIGEST:-}')
  })

  it('migrate 沒有輸出 SCHEMA_VERSION 就中止，不用空值通過健康判定', () => {
    expect(source).toContain('migrate 沒有輸出 SCHEMA_VERSION')
    const migrate = fs.readFileSync(path.join(repoRoot, 'web/scripts/migrate.mjs'), 'utf8')
    expect(migrate).toContain('SCHEMA_VERSION=${latestTag}')
  })

  it('健康判定的四個期望值都有傳給 check-health.mjs', () => {
    const start = source.indexOf('await_health() {')
    const awaitHealth = source.slice(start, source.indexOf('\n}', start))
    for (const name of ['EXPECT_TAG', 'EXPECT_DIGEST', 'EXPECT_SCHEMA', 'EXPECT_WORKER']) {
      expect(awaitHealth, `await_health 沒有傳 ${name}`).toContain(name)
    }
    expect(source).toContain('await_health "$TAG" "$NEW_DIGEST" "$NEW_SCHEMA" "$EXPECT_WORKER"')
  })
})

describe('ops/check-health.mjs：健康判定（契約 05 §3）', () => {
  const run = (health: unknown, env: Record<string, string>) =>
    exec('node', [checkHealth], {
      env: { ...process.env, HEALTH_JSON: JSON.stringify(health), ...env },
    })

  const good = {
    ok: true,
    version: '1.0.0',
    commit: 'abc123',
    imageDigest: 'sha256:aaa',
    schemaVersion: '0001_s00_roles_and_immutability',
    worker: { version: null, lastTickAt: null },
  }

  it('四項都符合、worker 是 null → 通過（E02 出場前）', async () => {
    const { stdout } = await run(good, {
      EXPECT_TAG: 'abc123',
      EXPECT_DIGEST: 'sha256:aaa',
      EXPECT_SCHEMA: '0001_s00_roles_and_immutability',
      EXPECT_WORKER: '0',
    })
    expect(stdout).toContain('健康判定通過')
  })

  it('commit 不是這次部署的 → 失敗', async () => {
    await expect(run({ ...good, commit: 'old999' }, { EXPECT_TAG: 'abc123' })).rejects.toThrow(/commit 是 old999/)
  })

  it('imageDigest 不符 → 失敗', async () => {
    await expect(
      run(good, { EXPECT_TAG: 'abc123', EXPECT_DIGEST: 'sha256:bbb' }),
    ).rejects.toThrow(/imageDigest/)
  })

  it('schemaVersion 不等於 migrate 輸出的名稱 → 失敗', async () => {
    await expect(
      run(good, { EXPECT_TAG: 'abc123', EXPECT_SCHEMA: '0002_something' }),
    ).rejects.toThrow(/schemaVersion/)
  })

  it('ok 是 false → 失敗', async () => {
    await expect(run({ ...good, ok: false }, { EXPECT_TAG: 'abc123' })).rejects.toThrow(/ok 是 false/)
  })

  it('旗標與階段不符：沒帶 --expect-worker 但 worker 已經有值 → 失敗', async () => {
    await expect(
      run(
        { ...good, worker: { version: 'abc123', lastTickAt: new Date().toISOString() } },
        { EXPECT_TAG: 'abc123', EXPECT_WORKER: '0' },
      ),
    ).rejects.toThrow(/worker 欄不是 null/)
  })

  it('帶 --expect-worker：worker 版本相符且心跳在 60 秒內 → 通過', async () => {
    const { stdout } = await run(
      { ...good, worker: { version: 'abc123', lastTickAt: new Date().toISOString() } },
      { EXPECT_TAG: 'abc123', EXPECT_WORKER: '1' },
    )
    expect(stdout).toContain('健康判定通過')
  })

  it('帶 --expect-worker：心跳超過 60 秒 → 失敗', async () => {
    await expect(
      run(
        {
          ...good,
          worker: { version: 'abc123', lastTickAt: new Date(Date.now() - 120_000).toISOString() },
        },
        { EXPECT_TAG: 'abc123', EXPECT_WORKER: '1' },
      ),
    ).rejects.toThrow(/lastTickAt/)
  })
})

describe('cd.yml：只能手動觸發、預設演練（契約 05 §3）', () => {
  const cd = YAML.parse(fs.readFileSync(path.join(repoRoot, '.github/workflows/cd.yml'), 'utf8')) as {
    on: Record<string, unknown>
    jobs: Record<string, { steps: { name?: string; if?: string; run?: string }[] }>
  }

  it('只有 workflow_dispatch，沒有 push 或 pull_request', () => {
    // YAML 的 `on:` 會被解析成布林 true，所以用鍵名比對。
    expect(Object.keys(cd.on)).toEqual(['workflow_dispatch'])
  })

  it('mode 預設是 dry-run', () => {
    const inputs = (cd.on.workflow_dispatch as { inputs: Record<string, { default?: string }> }).inputs
    expect(inputs.mode?.default).toBe('dry-run')
  })

  it('選了 execute 會直接失敗（S00 階段不准真部署）', () => {
    const guard = cd.jobs.deploy?.steps.find((s) => s.if?.includes("inputs.mode == 'execute'"))
    expect(guard, 'cd.yml 少了 execute 的擋門').toBeTruthy()
    expect(guard?.run).toContain('exit 1')
  })

  it('實際執行的那一步帶 --dry-run', () => {
    const deployStep = cd.jobs.deploy?.steps.find((s) => s.run?.includes('ops/deploy.sh'))
    expect(deployStep?.run).toContain('--dry-run')
  })
})

describe('image.yml：main 合併後推 GHCR（2026-09-24）', () => {
  const image = YAML.parse(fs.readFileSync(path.join(repoRoot, '.github/workflows/image.yml'), 'utf8')) as {
    on: Record<string, unknown>
    jobs: Record<
      string,
      { if?: string; permissions?: Record<string, string>; steps: { uses?: string; with?: Record<string, string> }[] }
    >
  }
  const publish = image.jobs.publish
  const build = publish?.steps.find((s) => s.uses?.startsWith('docker/build-push-action'))

  it('只在 main 上發布（別的分支手動觸發也不會把 :main 指過去）', () => {
    expect((image.on.push as { branches: string[] }).branches).toEqual(['main'])
    expect(publish?.if).toBe("github.ref == 'refs/heads/main'")
  })

  it('tag 是完整 SHA（等於 /api/health 的 commit）與 :main；GIT_COMMIT 也是完整 SHA', () => {
    expect(build?.with?.tags).toContain('ghcr.io/roy4222/fju-web:${{ github.sha }}')
    expect(build?.with?.tags).toContain('ghcr.io/roy4222/fju-web:main')
    expect(build?.with?.['build-args']).toContain('GIT_COMMIT=${{ github.sha }}')
    // auto-deploy.sh 從這個 label 讀出 :main 對應的 SHA。
    expect(build?.with?.labels).toContain('org.opencontainers.image.revision=${{ github.sha }}')
  })

  it('只有這個 job 有 packages: write，workflow 預設仍是唯讀', () => {
    expect((image as unknown as { permissions: Record<string, string> }).permissions).toEqual({ contents: 'read' })
    expect(publish?.permissions).toEqual({ contents: 'read', packages: 'write' })
  })
})

describe('ci.yml：契約 05 §2 的七道門檻', () => {
  const ci = YAML.parse(fs.readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8')) as {
    jobs: Record<string, unknown>
  }

  it('job 名稱固定為那七個', () => {
    expect(Object.keys(ci.jobs).sort()).toEqual(
      ['audit', 'build', 'e2e-smoke', 'integration', 'lint', 'typecheck', 'unit'].sort(),
    )
  })
})
