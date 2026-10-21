// 合法例（CL-7、⑤-12）：拒絕與資料不變各一支、各一個 expect；別名寫法同樣放行。
import { expect, it } from 'vitest'

const known = { refused: false, unchanged: false }
const check = known.refused ? it : it.fails

it.fails('已知漏擋：拒絕', () => {
  expect(known.refused).toBe(true)
})

check('已知漏擋：資料不變', () => {
  expect(known.unchanged).toBe(true)
})

it('一般的 it 不受限', () => {
  expect(1).toBe(1)
  expect(2).toBe(2)
})
