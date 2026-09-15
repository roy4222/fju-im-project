// 合法例 3：Server Component 經組裝根取得用例，不自己碰 infrastructure。
import { getDemoUseCase } from '../../composition/demo'

export default async function Page() {
  const rows = await getDemoUseCase().list()
  return <p>{rows.length}</p>
}
