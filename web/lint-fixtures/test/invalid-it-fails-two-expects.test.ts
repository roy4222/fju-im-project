// 反例（CL-7、⑤-12）：it.fails 主體兩個 expect——其中一個先修好，另一個還是讓它失敗，綠燈不再代表缺陷還在。
import { expect, it } from 'vitest'

const known = { refused: false, unchanged: false }
const check = known.refused ? it : it.fails

it.fails('已知漏擋：拒絕而且資料不變', () => {
  expect(known.refused).toBe(true)
  expect(known.unchanged).toBe(true)
})

check('別名也算', () => {
  expect(known.refused).toBe(true)
  expect(known.unchanged).toBe(true)
})
