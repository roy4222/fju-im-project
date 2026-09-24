import 'server-only'
import { normalizeRosterExportRequest, type GroupRosterExporter } from '@/application/groups'
import { resolveActor } from '@/composition/accounts'
import { getGroupQuery } from '@/composition/groups'
import { getAuditWriter } from '@/composition/ops'
import { PgGroupRosterExporter } from '@/infrastructure/groups/pg-roster-export'
import { err, type Result } from '@/shared/result'
import { taipeiParts } from '@/shared/time'

/**
 * 組別名單匯出的組裝（票 20；#105、C18）。
 *
 * 獨立一個檔、不放在 `composition/groups.ts`：這裡要認人（`resolveActor` → Better Auth），
 * 而 `composition/groups.ts` 會被背景工作（提案到期處理器）打包進去，worker 不能帶 Better Auth。
 */

let rosterExporter: GroupRosterExporter | undefined

export function getGroupRosterExporter(): GroupRosterExporter {
  rosterExporter ??= new PgGroupRosterExporter({ query: getGroupQuery(), audit: getAuditWriter() })
  return rosterExporter
}

/**
 * `POST /api/admin/groups/export` 的門面：每次重新認人、重新授權（契約 03 §4），授權**先於**驗證
 * （沒登入的人不該從錯誤訊息知道請求格式對不對）。檔名：`組別名單-<屆別>-<年月日-時分>.csv|xlsx`。
 */
export async function exportGroupRoster(
  headers: Headers,
  body: unknown,
): Promise<Result<{ body: string | Uint8Array; fileName: string; format: 'csv' | 'xlsx'; groupCount: number; rowCount: number }>> {
  const actor = await resolveActor(headers)
  if (actor.kind !== 'authenticated') return err('UNAUTHENTICATED', '請先登入。')
  if (!actor.roles.includes('admin')) return err('FORBIDDEN', '只有系辦可以匯出組別名單。')
  const request = normalizeRosterExportRequest(body)
  if (!request.ok) return request
  const result = await getGroupRosterExporter().exportRoster(actor, request.value)
  if (!result.ok) return result
  const t = taipeiParts(new Date(result.receipt.serverTime))
  const two = (n: number) => String(n).padStart(2, '0')
  const stamp = `${t.year}${two(t.month)}${two(t.day)}-${two(t.hour)}${two(t.minute)}`
  return {
    ...result,
    receipt: { ...result.receipt, fileName: `組別名單-${result.receipt.cohortCode}-${stamp}.${result.receipt.format}` },
  }
}
