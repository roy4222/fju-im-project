// 型別契約：照真正寫入端的輸出形狀寫成字面值，typecheck 那道會檢查它們能指派給 types.ts 的型別。
// 寫入端改了形狀、或型別收得太窄，這裡會先紅（tsc），S-5／S-6 才不會在用到時才發現。
import { describe, expect, expectTypeOf, it } from 'vitest'

import type { PersonaTask, SummaryJson } from './types'

describe('summary.json 的人設任務', () => {
  it('done 可以是 null：任務沒填「完成」那行時，彙整器輸出 null 且 parsed 仍是 true', () => {
    expectTypeOf<PersonaTask['done']>().toEqualTypeOf<string | null>()

    // 形狀照 e2e/acceptance/summarize-night.sh:233-236、:695-700。
    const summary = {
      runId: 'night-20261012-2200',
      plan: 'full',
      startedAt: null,
      finishedAt: null,
      commitStart: null,
      commitEnd: null,
      problemColumns: [],
      items: [
        {
          id: 'ux-grader', kind: 'ux', status: 'ok', resumed: false, dependencyNotMet: false, security: null,
          report: null, parsed: true, summaryLine: null, relay: null, counts: {}, steps: [], problems: [], errors: [],
        },
      ],
      personas: [
        {
          id: 'ux-grader',
          title: '評分老師',
          tasks: [
            { task: 1, score: 4, done: '完成' },
            { task: 2, score: null, done: null },
          ],
          average: 4,
        },
      ],
    } satisfies SummaryJson

    expect(summary.items[0]!.parsed).toBe(true)
    expect(summary.personas[0]!.tasks[1]!.done).toBeNull()
  })
})
