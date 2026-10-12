import { describe, expect, it } from 'vitest'

import type { GithubData, HealthData, VmData } from './types'
import { buildVersionRows, lastDeployedTag, sameSha } from './version'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

const github = { generatedAt: 't', mainSha: A, ci: { headSha: A } } as GithubData
const vm = (testTag: string, prodTag?: string) =>
  ({
    generatedAt: 't',
    deploys: {
      test: [
        { at: '2', event: 'rolled-back', tag: B, digest: null },
        { at: '1', event: 'deployed', tag: testTag, digest: null },
      ],
      prod: prodTag ? [{ at: '1', event: 'deployed', tag: prodTag, digest: null }] : [],
    },
  }) as unknown as VmData
const health = (test: string | null, prod: string | null) =>
  ({ generatedAt: 't', test: { commit: test }, prod: { commit: prod }, accessGuard: [] }) as unknown as HealthData

describe('版本卡片', () => {
  it('只看最後一次 deployed，不看回滾', () => {
    expect(lastDeployedTag(vm(A), 'test')).toBe(A)
    expect(lastDeployedTag(vm(A), 'prod')).toBeNull()
    expect(lastDeployedTag(null, 'test')).toBeNull()
  })

  it('三個都相同 → 不標黃；短 SHA 與完整 SHA 視為相同', () => {
    const [test] = buildVersionRows({ github, vm: vm(A), health: health(A.slice(0, 7), null) })
    expect(test).toMatchObject({ site: 'test', ciSha: A, deployedTag: A, mismatch: false })
  })

  it('任一不同 → 標黃', () => {
    const [test, prod] = buildVersionRows({ github, vm: vm(A, B), health: health(B, B) })
    expect(test!.mismatch).toBe(true)
    expect(prod!.mismatch).toBe(true)
  })

  it('沒有資料的欄位不算不同；全部沒資料也不標黃', () => {
    const [, prod] = buildVersionRows({ github, vm: vm(A), health: health(A, null) })
    expect(prod).toMatchObject({ deployedTag: null, healthCommit: null, mismatch: false })
    expect(buildVersionRows({ github: null, vm: null, health: null }).every((r) => !r.mismatch)).toBe(true)
  })

  it('sameSha：不到 7 碼必須完全相同', () => {
    expect(sameSha('abc', 'abcdef0')).toBe(false)
    expect(sameSha('ABCDEF0', 'abcdef0123')).toBe(true)
  })
})
