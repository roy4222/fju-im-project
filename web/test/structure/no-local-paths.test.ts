import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// 公開 repo 的文件不能帶本機路徑（含帳號名）。Vault 鏡像進來時，
// 本機的 Vault 路徑一律寫成 `Vault:專案/…`（定義見 docs/README.md 開頭）。
const repoRoot = path.resolve(import.meta.dirname, '../../..')
const scopes = ['docs', 'CONTEXT.md', 'steps', 'e2e/acceptance']
// 斜線寫法 /Users/…，以及 Claude 工作目錄把斜線換成橫線的 -Users-…
const localPath = /\/Users\/|-Users-/

describe('公開文件不含本機路徑', () => {
  it('比對規則：斜線與橫線寫法都會紅', () => {
    expect(localPath.test('/Users/someone/x')).toBe(true)
    expect(localPath.test('/private/tmp/-Users-someone-proj/x')).toBe(true)
    expect(localPath.test('Vault:專案/x、/home/deploy/.ssh')).toBe(false)
  })

  it('docs/、CONTEXT.md、steps/、e2e/acceptance/ 沒有本機路徑', () => {
    const files = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files', '-z', '--', ...scopes], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\0')
      .filter((f) => f && existsSync(path.join(repoRoot, f)))
    const hits: string[] = []
    for (const file of files) {
      const buf = readFileSync(path.join(repoRoot, file))
      if (buf.includes(0)) continue
      buf
        .toString('utf8')
        .split('\n')
        .forEach((line, i) => {
          if (localPath.test(line)) hits.push(`${file}:${i + 1}`)
        })
    }
    expect(
      hits,
      `這些位置含本機路徑 /Users/…：把 Vault 路徑改成 Vault:專案/…，repo 內路徑改相對路徑，其餘用 <home>/ 佔位字。\n${hits.slice(0, 20).join('\n')}`,
    ).toEqual([])
  })
})
