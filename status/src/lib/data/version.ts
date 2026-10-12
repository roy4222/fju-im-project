/**
 * 頁首「版本卡片」（設計方案 §3.8 補充）：每站三個 SHA 並排——
 * main 上 CI 的 SHA、deploy_log 最後一次 `deployed` 的 tag、`/api/health` 實際回報的 `commit`。
 * 有值的幾個彼此不同時標黃。這是資訊，不是上線條件。
 */
import type { GithubData, HealthData, Site, VmData } from './types'

export type VersionRow = {
  site: Site
  ciSha: string | null
  deployedTag: string | null
  healthCommit: string | null
  /** 有值的 SHA 彼此不同 → 標黃 */
  mismatch: boolean
}

/** 完整 SHA 與短 SHA 都可能出現：較短的一方是另一方的開頭就算相同（至少 7 碼）。 */
export function sameSha(a: string, b: string): boolean {
  const x = a.trim().toLowerCase()
  const y = b.trim().toLowerCase()
  if (x.length < 7 || y.length < 7) return x === y
  return x.startsWith(y) || y.startsWith(x)
}

export const shortSha = (sha: string | null) => (sha ? sha.slice(0, 7) : null)

export function lastDeployedTag(vm: VmData | null, site: Site): string | null {
  // deploys 是新到舊；只看 event = deployed（回滾、種子失敗等不算）。
  return vm?.deploys?.[site]?.find((e) => e.event === 'deployed')?.tag ?? null
}

export function buildVersionRows(input: {
  github: GithubData | null
  vm: VmData | null
  health: HealthData | null
}): VersionRow[] {
  const ciSha = input.github?.ci?.headSha ?? null
  return (['test', 'prod'] as const).map((site) => {
    const deployedTag = lastDeployedTag(input.vm, site)
    const healthCommit = input.health?.[site]?.commit ?? null
    const present = [ciSha, deployedTag, healthCommit].filter((s): s is string => !!s)
    const mismatch = present.some((s) => !sameSha(s, present[0]!))
    return { site, ciSha, deployedTag, healthCommit, mismatch }
  })
}
