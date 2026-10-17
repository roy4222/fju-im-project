// perf:sql 的純邏輯（judge）。scripts/perf 不在 vitest 的 unit 專案裡，用 node 內建測試跑：
//   node --test 'web/scripts/perf/*.test.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { judge } from './sql.mjs'

const P = 'select a.id from evaluator_assignments '
const row = (duplicates = []) => ({ total: 10, identity: 7, duplicates })

test('noDuplicate：對得到、沒重複 → 過', () => {
  assert.deepEqual(judge(row(), { noDuplicate: [P] }, [`${P}where x`]), [])
})

test('noDuplicate：重複 → 失敗並列出次數', () => {
  const sig = `${P}where x`
  assert.deepEqual(judge(row([{ sig, count: 2 }]), { noDuplicate: [P] }, [sig, sig]), [`重複：${P}（2 次）`])
})

test('noDuplicate：該路由一句都對不到（比對字串過期）→ 失敗並印出是哪一條', () => {
  assert.deepEqual(judge(row(), { noDuplicate: [P] }, ['select a.id, v.stages, x from evaluator_assignments ']), [
    `對不到任何一句（比對字串可能過期）：${P}`,
  ])
})

test('沒有 noDuplicate 時不看語句', () => {
  assert.deepEqual(judge(row(), { max: 10, identity: 7 }, []), [])
})
