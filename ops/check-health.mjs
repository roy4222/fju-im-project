#!/usr/bin/env node
/**
 * 部署的健康判定（契約 05 §3）。由 ops/deploy.sh 呼叫。
 *
 * 讀環境變數：
 *   HEALTH_JSON    /api/health 的回應內容
 *   EXPECT_TAG     這次部署的 tag（commit）
 *   EXPECT_DIGEST  這次部署的映像 digest（有給才比對）
 *   EXPECT_SCHEMA  migrate 輸出的最後一支 migration 名稱（有給才比對）
 *   EXPECT_WORKER  '1'＝一定要有 worker 心跳（完整六項）；其他值＝worker 有回報就一起判、
 *                  兩欄都是 null（還沒有 worker 的舊映像）才只判前四項
 *
 * 全部符合回 0，否則印出不符的項目並回 1。
 */
const raw = process.env.HEALTH_JSON ?? ''
const expectTag = process.env.EXPECT_TAG ?? ''
const expectDigest = process.env.EXPECT_DIGEST ?? ''
const expectSchema = process.env.EXPECT_SCHEMA ?? ''
const expectWorker = process.env.EXPECT_WORKER === '1'

const problems = []
let health
try {
  health = JSON.parse(raw)
} catch {
  console.error('健康判定失敗：/api/health 沒有回合法的 JSON')
  process.exit(1)
}

if (health.ok !== true) problems.push(`ok 是 ${JSON.stringify(health.ok)}，不是 true`)
if (expectTag && health.commit !== expectTag) {
  problems.push(`commit 是 ${health.commit}，不是這次部署的 ${expectTag}`)
}
if (expectDigest && health.imageDigest !== expectDigest) {
  problems.push(`imageDigest 是 ${health.imageDigest}，不是這次部署的 ${expectDigest}`)
}
if (expectSchema && health.schemaVersion !== expectSchema) {
  problems.push(`schemaVersion 是 ${health.schemaVersion}，不是 migrate 輸出的 ${expectSchema}`)
}

const worker = health.worker ?? {}

/** worker 有心跳時要符合的兩項：版本＝這次部署、最近 60 秒內有心跳。 */
function checkWorkerBeat() {
  if (expectTag && worker.version !== expectTag) {
    problems.push(`worker.version 是 ${worker.version}，不是這次部署的 ${expectTag}`)
  }
  if (!worker.lastTickAt) {
    problems.push('worker.lastTickAt 是空的')
  } else {
    const ageMs = Date.now() - Date.parse(worker.lastTickAt)
    if (!Number.isFinite(ageMs) || ageMs > 60_000) {
      problems.push(`worker.lastTickAt (${worker.lastTickAt}) 不在 60 秒內`)
    }
  }
}

if (expectWorker) {
  // 完整六項（--expect-worker）：worker 必須是這次的版本，而且最近 60 秒有心跳。
  checkWorkerBeat()
} else if (worker.version !== null || worker.lastTickAt !== null) {
  // 沒帶旗標（票 12 起的預設相容模式）：worker 已經回報心跳，就跟完整模式一樣要求「有心跳即健康」；
  // 兩欄都是 null 只會出現在還沒有 worker 的舊映像（例如回滾到票 12 之前的版本），那時照舊只判前四項。
  checkWorkerBeat()
}

if (problems.length > 0) {
  console.error('健康判定不符：')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log('健康判定通過')
