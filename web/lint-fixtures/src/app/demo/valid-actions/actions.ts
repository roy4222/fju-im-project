'use server'
// 合法例 1（其一）：檔頭 'use server'，只匯出 async 函式，函式內才取用例。
import { getDemoUseCase } from '../../../composition/demo'

export async function submitDemo(requestId: string) {
  return getDemoUseCase().submit(requestId)
}
