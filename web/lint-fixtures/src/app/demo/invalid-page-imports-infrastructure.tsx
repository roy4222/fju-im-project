// 反例 4：app 要經 composition 取得用例，不可以直接碰 infrastructure。
// 預期被擋：boundaries/element-types
import { db } from '../../infrastructure/demo-db'

export default function Page() {
  return <p>{db.rows.length}</p>
}
