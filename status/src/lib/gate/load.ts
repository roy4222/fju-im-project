/** 讀「能不能上線」要的檔：collector 的 JSON＋latestFullAttempt 那夜的 run.json／summary.json。 */
import { dataOrNull, readData, readRunJson, readSummaryJson, type ReadResult } from '@/lib/data/read'
import type { SummaryJson } from '@/lib/data/types'

import type { GateInput } from './types'

export async function loadGateInput(env?: NodeJS.ProcessEnv): Promise<GateInput> {
  const [github, health, vm, index, policy, waivers] = await Promise.all([
    readData('github.json', env).then(dataOrNull),
    readData('health.json', env).then(dataOrNull),
    readData('vm.json', env).then(dataOrNull),
    readData('acceptance-index.json', env).then(dataOrNull),
    readData('repo/go-live-policy.json', env),
    readData('repo/go-live-waivers.json', env).then(dataOrNull),
  ])
  const runId = index?.latestFullAttempt ?? null
  const [run, summary] = runId
    ? await Promise.all([readRunJson(runId, env).then(dataOrNull), readSummaryJson(runId, env)])
    : [null, { status: 'missing' } as ReadResult<SummaryJson>]
  return { github, health, vm, acceptance: { index, run, summary, policy, waivers } }
}
