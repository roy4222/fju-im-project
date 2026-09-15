// 反例 2：domain 不可以往外層引用。
// 預期被擋：boundaries/element-types
import { db } from '../../infrastructure/demo-db'

export function count() {
  return db.rows.length
}
