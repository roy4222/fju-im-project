/**
 * run manifest 的最小輸出（契約 04 §7）。
 *
 * 整合測試跑完寫一份 `manifest.json`，把「這次是哪個版本、哪個 schema、什麼時間、
 * 誰跑的」記下來，讓證據可以追溯到 commit 與 schema 版本。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export type RunKind = 'mainline' | 'branch' | 'partial'

export type RunManifest = {
  runId: string
  kind: RunKind
  commit: string
  imageDigest: string | null
  schemaVersion: string | null
  workerVersion: string | null
  env: string
  dataset: string
  businessClockStart: string | null
  startedAt: string
  operator: string
}

function currentCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

export function buildRunManifest(input: {
  runId: string
  kind?: RunKind
  env?: string
  dataset?: string
  schemaVersion?: string | null
  imageDigest?: string | null
  workerVersion?: string | null
  businessClockStart?: string | null
  operator?: string
  startedAt?: Date
}): RunManifest {
  return {
    runId: input.runId,
    kind: input.kind ?? 'partial',
    commit: currentCommit(),
    imageDigest: input.imageDigest ?? process.env.IMAGE_DIGEST ?? null,
    schemaVersion: input.schemaVersion ?? null,
    workerVersion: input.workerVersion ?? null,
    env: input.env ?? process.env.APP_ENV ?? 'local',
    dataset: input.dataset ?? 'empty',
    businessClockStart: input.businessClockStart ?? null,
    startedAt: (input.startedAt ?? new Date()).toISOString(),
    operator: input.operator ?? process.env.RUN_OPERATOR ?? 'automated',
  }
}

/** 寫到 `<dir>/manifest.json`，回傳檔案路徑。 */
export function writeRunManifest(dir: string, manifest: RunManifest): string {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'manifest.json')
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n')
  return file
}
