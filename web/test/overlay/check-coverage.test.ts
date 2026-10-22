/**
 * `overlay check` 的涵蓋範圍（CL-7 #823 第 6 條）：repo 裡每一個有基底檔的 `.d/` 小檔資料夾都要被檢查到。
 * 之前只檢查三個固定基底，`sql-expect.timeline-*.d/` 放了壞掉的 JSON，`pnpm -C web overlay check` 照樣 exit 0。
 *
 * 反例在暫存目錄裡跑一份複製出來的 cli（不動 repo 的小檔）。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'

const WEB = fileURLToPath(new URL('../..', import.meta.url))
/** 放基底檔與小檔資料夾的地方（`.d/` 旁邊一定有同名的 `.json` 或 `.ts`）。 */
const OVERLAY_HOMES = ['e2e', 'scripts/perf']

/** `root` 底下每個 `X.d/` 且旁邊有 `X.json`／`X.ts` 的資料夾（相對 `root`）。 */
function overlayDirs(root: string): string[] {
  return OVERLAY_HOMES.flatMap((home) =>
    fs
      .readdirSync(path.join(root, home), { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.endsWith('.d'))
      .filter((d) => ['.json', '.ts'].some((ext) => fs.existsSync(path.join(root, home, d.name.slice(0, -2) + ext))))
      .map((d) => `${home}/${d.name}`),
  ).sort()
}

const check = (root: string) => spawnSync(process.execPath, [path.join(root, 'scripts/overlay/cli.mjs'), 'check'], { cwd: root, encoding: 'utf8' })

let tmp: string | null = null
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  tmp = null
})

/** 把 cli 跑得起來需要的檔複製到暫存目錄（overlay 工具、限額、所有基底與小檔）。 */
function copyTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fju-overlay-check-'))
  const copy = (rel: string) => fs.cpSync(path.join(WEB, rel), path.join(root, rel), { recursive: true })
  copy('scripts/overlay')
  copy('scripts/perf/limits.mjs')
  for (const home of OVERLAY_HOMES) {
    for (const name of fs.readdirSync(path.join(WEB, home))) {
      if (/\.d$/.test(name) || /^(sql-expect.*|budget)\.json$/.test(name) || name === 'fingerprints.ts') copy(`${home}/${name}`)
    }
  }
  return root
}

describe('overlay check 涵蓋所有小檔資料夾', () => {
  test('repo 裡的每個 .d/（含 sql-expect.timeline-*.d/）都出現在 check 的輸出，且 exit 0', () => {
    const dirs = overlayDirs(WEB)
    expect(dirs).toEqual(expect.arrayContaining(['e2e/fingerprints.d', 'scripts/perf/budget.d', 'scripts/perf/sql-expect.d']))
    expect(dirs.some((d) => d.includes('sql-expect.timeline-'))).toBe(true)
    const r = check(WEB)
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    const listed = r.stdout.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean)
    expect(listed.sort()).toEqual(dirs)
  })

  test.each(['scripts/perf/sql-expect.timeline-admin.d', 'scripts/perf/sql-expect.timeline-teacher.d', 'scripts/perf/sql-expect.d'])(
    '反例：%s 放一個壞掉的 JSON → check exit 1，錯誤指出那個檔',
    (dir) => {
      tmp = copyTree()
      expect(check(tmp).status).toBe(0)
      fs.mkdirSync(path.join(tmp, dir), { recursive: true })
      fs.writeFileSync(path.join(tmp, dir, 'C9-99.json'), '{ "set": ')
      const r = check(tmp)
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('C9-99.json 不是合法 JSON')
    },
  )
})
