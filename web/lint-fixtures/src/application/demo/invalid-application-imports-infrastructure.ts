// 反例 3：application 只能宣告 port，不可以引用 infrastructure 的實作。
// 預期被擋：boundaries/element-types
import { db } from '../../infrastructure/demo-db'

export function listRows() {
  return db.rows
}
