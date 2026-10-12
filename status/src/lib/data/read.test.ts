import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

import { acceptanceDir, dataDir, isSafeSegment, readData, readRunJson, readSummaryJson } from './read'

let dir: string
let env: NodeJS.ProcessEnv

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'status-read-'))
  await mkdir(path.join(dir, 'data', 'repo'), { recursive: true })
  await mkdir(path.join(dir, 'acc', 'night-1'), { recursive: true })
  await writeFile(path.join(dir, 'data', 'github.json'), JSON.stringify({ generatedAt: 't', mainSha: 'abc', prs: [] }))
  await writeFile(path.join(dir, 'data', 'health.json'), '{壞掉')
  await writeFile(path.join(dir, 'data', 'vm.json'), '[1,2]')
  await writeFile(path.join(dir, 'acc', 'night-1', 'run.json'), JSON.stringify({ runId: 'night-1', plan: 'full', items: [] }))
  env = { NODE_ENV: 'production', STATUS_DATA_DIR: path.join(dir, 'data'), STATUS_ACCEPTANCE_DIR: path.join(dir, 'acc') }
})

describe('目錄', () => {
  it('正式模式預設 /data、/acceptance；有設環境變數就用它', () => {
    expect(dataDir({ NODE_ENV: 'production' })).toBe('/data')
    expect(acceptanceDir({ NODE_ENV: 'production' })).toBe('/acceptance')
    expect(dataDir({ NODE_ENV: 'production', STATUS_DATA_DIR: '/x' })).toBe('/x')
  })
  it('本機沒設時讀 fixtures/base', () => {
    expect(dataDir({ NODE_ENV: 'development' })).toBe(path.join(process.cwd(), 'fixtures', 'base', 'data'))
  })
})

describe('readData', () => {
  it('合法 → ok；不存在 → missing；壞 JSON、不是物件 → invalid', async () => {
    const gh = await readData('github.json', env)
    expect(gh.status).toBe('ok')
    if (gh.status === 'ok') expect(gh.data.mainSha).toBe('abc')
    expect((await readData('collector.json', env)).status).toBe('missing')
    expect((await readData('health.json', env)).status).toBe('invalid')
    expect((await readData('vm.json', env)).status).toBe('invalid')
  })
})

describe('驗收 run', () => {
  it('讀 run.json；summary.json 沒有就是 missing', async () => {
    expect((await readRunJson('night-1', env)).status).toBe('ok')
    expect((await readSummaryJson('night-1', env)).status).toBe('missing')
  })
  it('runId 帶路徑字元一律拒絕，不碰檔案系統', async () => {
    for (const bad of ['..', '.', '../data', 'a/b', '', 'x y']) {
      expect(isSafeSegment(bad), bad).toBe(false)
      expect((await readRunJson(bad, env)).status).toBe('invalid')
    }
  })
})
