// 合法例 2：application 透過公開入口引用本模組 domain，並用 shared 的 Result。
import { isDemoId, type DemoId } from '../../domain/demo'
import { err, ok, type Result } from '@/shared/result'

export function parseDemoId(raw: string, meta: { requestId: string; serverTime: string }): Result<{ id: DemoId }> {
  return isDemoId(raw) ? ok({ id: raw }, meta) : err('VALIDATION_FAILED', 'demo id 不可為空')
}
