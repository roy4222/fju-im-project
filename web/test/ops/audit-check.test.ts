import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import path from 'node:path'

const script = path.join(import.meta.dirname, '..', '..', 'scripts', 'audit-check.mjs')

/**
 * R1：稽核本身沒跑成功時，絕對不能被當成「沒有漏洞」。
 *
 * CI 是 `pnpm audit --json > audit.json || true`——`|| true` 是必要的（找到漏洞時
 * pnpm 本來就回非 0），但也因此吞掉了「registry 掛了」「離線」「輸出被截斷」這些情況。
 * 所以把關的責任落在這支腳本：報告不完整就非 0。
 */
function run(stdin: string, args: string[] = ['--level', 'high']) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile('node', [script, ...args], (error, stdout, stderr) => {
      resolve({ code: error && typeof error.code === 'number' ? error.code : 0, stdout, stderr })
    })
    child.stdin?.end(stdin)
  })
}

const emptyButValid = JSON.stringify({
  advisories: {},
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } },
})

describe('稽核沒跑成功就必須失敗', () => {
  it('pnpm 回報 registry 錯誤', async () => {
    const result = await run(JSON.stringify({ error: { code: 'ERR_PNPM_AUDIT_BAD_RESPONSE', message: 'registry error' } }))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('沒有成功執行')
    expect(result.stderr).toContain('ERR_PNPM_AUDIT_BAD_RESPONSE')
    expect(result.stdout).not.toContain('沒有影響 web/')
  })

  it('stdin 是空的（指令根本沒跑）', async () => {
    const result = await run('')
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('stdin 是空的')
  })

  it('輸出不是 JSON', async () => {
    const result = await run('pnpm: command not found')
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('不是合法 JSON')
  })

  it('輸出是 JSON 但不是物件', async () => {
    expect((await run('[]')).code).toBe(1)
    expect((await run('"hi"')).code).toBe(1)
  })

  it('缺 advisories', async () => {
    const result = await run(JSON.stringify({ metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } } }))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('advisories')
  })

  it('缺 metadata.vulnerabilities', async () => {
    const result = await run(JSON.stringify({ advisories: {} }))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('metadata.vulnerabilities')
  })

  it('metadata 的某個等級不是數字', async () => {
    const result = await run(
      JSON.stringify({ advisories: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 'many', critical: 0 } } }),
    )
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('high')
  })

  it('metadata 的件數與 advisories 對不上（輸出被截斷）', async () => {
    const result = await run(
      JSON.stringify({ advisories: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 2, critical: 0 } } }),
    )
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('報告不完整')
  })
})

describe('報告完整時照常判斷', () => {
  it('真的沒有漏洞就通過', async () => {
    const result = await run(emptyButValid)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('沒有影響 web/')
  })

  it('只影響 prototype 的不擋', async () => {
    const result = await run(
      JSON.stringify({
        advisories: {
          '1': {
            severity: 'critical',
            module_name: 'next',
            url: 'https://example.invalid/1',
            findings: [{ paths: ['prototype>next'] }],
          },
        },
        metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 1 } },
      }),
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('只影響 prototype/（不部署，不擋）：1 件')
  })

  it('影響 web/ 的就擋', async () => {
    const result = await run(
      JSON.stringify({
        advisories: {
          '1': {
            severity: 'high',
            module_name: 'lodash',
            url: 'https://example.invalid/1',
            findings: [{ paths: ['prototype>lodash', 'web>a>lodash'] }],
          },
        },
        metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 } },
      }),
    )
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('lodash')
    expect(result.stderr).toContain('web>a>lodash')
  })

  it('低於門檻的不擋', async () => {
    const result = await run(
      JSON.stringify({
        advisories: {
          '1': { severity: 'moderate', module_name: 'x', findings: [{ paths: ['web>x'] }] },
        },
        metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 0 } },
      }),
    )
    expect(result.code).toBe(0)
  })

  it('advisory 沒有相依路徑時保守當成會擋，不是默默放行', async () => {
    const result = await run(
      JSON.stringify({
        advisories: { '1': { severity: 'critical', module_name: 'mystery', findings: [] } },
        metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 1 } },
      }),
    )
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('mystery')
  })

  it('`web` 開頭但不是同一個套件的路徑不算（webpack 之類）', async () => {
    const result = await run(
      JSON.stringify({
        advisories: {
          '1': { severity: 'high', module_name: 'x', findings: [{ paths: ['webpack-thing>x'] }] },
        },
        metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 } },
      }),
    )
    expect(result.code).toBe(0)
  })

  it('--level 給錯值就拒絕，不用預設蒙混', async () => {
    const result = await run(emptyButValid, ['--level', 'nope'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('--level')
  })
})
