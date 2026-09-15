import { expect, test } from 'vitest'

// S00-09 的負向 CI 證據；本 PR 故意失敗，絕不可合併。
test('S00-09 deliberate failure proves the unit CI job turns red', () => {
  expect('intentional-red-proof').toBe('this-must-fail')
})
