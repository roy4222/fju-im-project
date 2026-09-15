// 反例 10：domain 之間也一樣——跨模組只能帶型別。
// 預期被擋：fju/module-boundary
import { makeOtherId } from '../../domain/other'

export function build(raw: string) {
  return makeOtherId(raw)
}
