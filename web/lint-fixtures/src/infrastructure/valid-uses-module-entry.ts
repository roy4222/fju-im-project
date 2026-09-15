import 'server-only'
// 合法例 6：infrastructure 實作 port，從 application 的公開入口拿執行期的東西——
// 這是規格允許的，不可以被誤擋（母 spec §4.3「infrastructure 可以引用 domain 與 application 公開入口（實作 port）」）。
import { parseDemoId } from '../application/demo'

export function makeParser() {
  return parseDemoId
}
