// 反例 8：跨模組的執行期呼叫要走 composition 注入的 port，import 只能帶型別。
// 預期被擋：fju/module-boundary
import { isDemoId } from '../../domain/demo'

export function check(raw: string): boolean {
  return isDemoId(raw)
}
