import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * CL-7（#823 第 11 條）：`.env.example` 不准列「空字串」和「沒設」行為不同的鍵。
 * 從 `compose.integration.test.ts` 拆出來的單元測試（CL-10 單檔 5,000 tokens 上限；這段不需要 Docker，`verify` 就會跑）。
 */

const repoRoot = path.join(import.meta.dirname, '..', '..', '..')
const lines = fs
  .readFileSync(path.join(repoRoot, '.env.example'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l.length > 0 && !l.startsWith('#'))

describe('「空字串」和「沒設」行為不同的鍵不准列（CL-7 #823 第 11 條）', () => {
  // 照 .env.example 複製成 .env 會把每個鍵都設成空字串；程式若把「沒設」跟「空字串」分開處理，
  // 留空就等於悄悄選了另一種行為（RV-C #828：IMAGE_DIGEST 留空時 /api/health 回 "" 而不是 null）。
  const names = new Set(lines.map((l) => l.slice(0, -1)))

  /** 自動掃描抓不到、但確定「空字串≠沒設」的鍵：不准出現在 .env.example。 */
  const KNOWN_EMPTY_DIFFERS: Record<string, string> = {
    REGISTRATION_OPEN:
      '沒有這個鍵才算開放註冊，空字串當關閉（registration-switch.ts）；VM 由 docker-compose.vm.yml 的 ${REGISTRATION_OPEN:-false} 給值',
  }

  /** 掃得到 `?? `／`=== undefined`，但空字串跟沒設結果一樣（或是必填鍵），可以留在 .env.example。 */
  const ALLOWED: Record<string, string> = {
    BETTER_AUTH_URL: "必填（ops/lib/site.sh 的 FJU_REQUIRED_SECRETS 擋空值）；程式裡一律寫 `?? ''`，空字串與沒設結果相同",
    GOOGLE_CLIENT_ID: "必填（FJU_REQUIRED_SECRETS）；auth-instance.ts 寫 `?? ''`，空字串與沒設結果相同",
    GOOGLE_CLIENT_SECRET: "必填（FJU_REQUIRED_SECRETS）；auth-instance.ts 寫 `?? ''`，空字串與沒設結果相同",
    DATABASE_URL: '必填（FJU_REQUIRED_SECRETS）；只有 scripts/auth-generate.mjs 產生 schema 時給佔位值，不連線',
    BETTER_AUTH_SECRET: '必填（FJU_REQUIRED_SECRETS）；只有 scripts/auth-generate.mjs 產生 schema 時給佔位值，不連線',
    HEALTHCHECKS_WORKER_URL: "composition/worker.ts 寫 `?? ''` 再 trim，空字串與沒設一樣＝不打卡（compose 測試 AC-40a 也斷言沒設時是空字串）",
    GIT_COMMIT:
      '本機 `.env` 照範本留空時，app 與 worker 容器拿到空字串（${GIT_COMMIT:-unknown} 只是 build 參數），worker 回報空字串（worker-main.ts 在 composition，另開票修；health-reader.ts 已把空字串當沒設）；VM 由 Doppler 給值',
  }

  /** 找出把「沒設」單獨處理的寫法：`process.env.X ??`、`process.env.X === undefined`、`'X' in process.env`，以及先存進變數再比 undefined。 */
  function scanEmptyDiffers(src: string): string[] {
    const found = new Set<string>()
    const direct =
      /process\.env(?:\.([A-Z][A-Z0-9_]*)|\[['"]([A-Z][A-Z0-9_]*)['"]\])\s*(?:\?\?|[!=]==?\s*undefined)|['"]([A-Z][A-Z0-9_]*)['"]\s+in\s+process\.env/g
    for (const m of src.matchAll(direct)) found.add(m[1] ?? m[2] ?? m[3] ?? '')
    for (const m of src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*process\.env\.([A-Z][A-Z0-9_]*)\s*(?:\n|;)/g)) {
      if (new RegExp(`\\b${m[1] ?? ''}\\s*(?:\\?\\?|[!=]==?\\s*undefined)`).test(src)) found.add(m[2] ?? '')
    }
    return [...found]
  }

  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const p = path.join(dir, d.name)
      if (d.isDirectory()) return d.name === 'node_modules' ? [] : sourceFiles(p)
      return /\.(ts|tsx|mjs)$/.test(d.name) && !/\.test\.(ts|tsx|mjs)$/.test(d.name) ? [p] : []
    })
  }

  const hits = new Map<string, string[]>()
  for (const file of ['src', 'scripts'].flatMap((d) => sourceFiles(path.join(repoRoot, 'web', d)))) {
    for (const name of scanEmptyDiffers(fs.readFileSync(file, 'utf8'))) {
      hits.set(name, [...(hits.get(name) ?? []), path.relative(repoRoot, file)])
    }
  }

  it('已知名單裡的鍵不在 .env.example', () => {
    for (const [name, why] of Object.entries(KNOWN_EMPTY_DIFFERS)) {
      expect(names.has(name), `${name} 不該列在 .env.example：${why}`).toBe(false)
    }
  })

  it('掃到的鍵若在 .env.example，必須在白名單附理由；白名單沒有過時的列', () => {
    const offending = [...hits]
      .filter(([name]) => names.has(name) && !(name in ALLOWED))
      .map(([name, files]) => `${name}（${files.join('、')}）`)
    expect(offending, '這些鍵空字串和沒設行為不同：從 .env.example 拿掉、改程式把空字串當沒設，或列進白名單附理由').toEqual([])
    const stale = Object.keys(ALLOWED).filter((name) => !hits.has(name) || !names.has(name))
    expect(stale, '白名單裡這些鍵已經掃不到（或不在 .env.example），請拿掉').toEqual([])
  })

  it('掃描本身抓得到：REGISTRATION_OPEN（先存變數再比 undefined）、反例 `process.env.IMAGE_DIGEST ?? null` 會被擋', () => {
    expect(hits.has('REGISTRATION_OPEN')).toBe(true)
    expect(scanEmptyDiffers("imageDigest: process.env.IMAGE_DIGEST ?? null,")).toEqual(['IMAGE_DIGEST'])
    expect(scanEmptyDiffers("if (process.env['APP_VERSION'] === undefined) {}")).toEqual(['APP_VERSION'])
    expect(scanEmptyDiffers("const on = 'MAIL_CAPTURE' in process.env")).toEqual(['MAIL_CAPTURE'])
    expect(names.has('IMAGE_DIGEST') && !('IMAGE_DIGEST' in ALLOWED)).toBe(true)
  })
})
