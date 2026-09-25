#!/usr/bin/env node
/**
 * 部署的健康判定（契約 05 §3）。由 ops/deploy.sh 呼叫。
 *
 * 讀環境變數：
 *   HEALTH_JSON    /api/health 的回應內容
 *   EXPECT_TAG     這次部署的 tag（commit）
 *   EXPECT_DIGEST  這次部署的映像 digest（有給才比對）
 *   EXPECT_SCHEMA  migrate 輸出的最後一支 migration 名稱（有給才比對）
 *   EXPECT_WORKER  沒給或 '1'＝完整六項（票 28 起 deploy.sh 的預設）：worker.version＝這次部署、
 *                  worker.lastTickAt 在 60 秒內，兩項都要符合。
 *                  'none'＝有限四項（只給 `deploy.sh --allow-no-worker`，回滾到票 12 之前、
 *                  還沒有 worker 的舊映像用）：worker 兩欄必須都是 null；舊映像卻回報了心跳＝
 *                  旗標與版本不符，一樣判失敗（契約 05 §3「旗標與階段不符即失敗」）。
 *                  '0'＝票 12～27 的舊 deploy.sh 沒帶旗標時傳的值，保留原本的意思（worker 有回報
 *                  就一起判，兩欄都是 null 才只判前四項）。只為了 VM 同步 ops 那一刻新舊檔混用時
 *                  不誤判；新的 deploy.sh 不會再傳它。
 *
 * 全部符合回 0，否則印出不符的項目並回 1。
 */
const raw = process.env.HEALTH_JSON ?? ''
const expectTag = process.env.EXPECT_TAG ?? ''
const expectDigest = process.env.EXPECT_DIGEST ?? ''
const expectSchema = process.env.EXPECT_SCHEMA ?? ''
// 沒給就是完整六項：少傳一個環境變數不能讓判定默默變寬鬆。
const workerMode = { none: 'none', 0: 'if-present' }[process.env.EXPECT_WORKER ?? ''] ?? 'full'

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

if (workerMode === 'full') {
  // 完整六項（預設）：worker 必須是這次的版本，而且最近 60 秒有心跳。
  checkWorkerBeat()
} else if (worker.version !== null || worker.lastTickAt !== null) {
  if (workerMode === 'none') {
    // 有限四項只給「還沒有 worker 的舊映像」用；回報了心跳就代表旗標用錯了，照契約判失敗。
    problems.push('帶了 --allow-no-worker，但這個映像有 worker 心跳：請拿掉旗標，用完整六項判定')
  } else {
    // 舊 deploy.sh 的相容模式：worker 已經回報心跳，就跟完整模式一樣比對。
    checkWorkerBeat()
  }
}

if (problems.length > 0) {
  console.error('健康判定不符：')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log('健康判定通過')
