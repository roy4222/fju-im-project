import 'server-only'
import { normalizeGradeExportRequest, type GradeExporter } from '@/application/grading'
import { resolveActor } from '@/composition/accounts'
import { getGradebookQuery } from '@/composition/grading'
import { getAuditWriter } from '@/composition/ops'
import { PgGradeExporter } from '@/infrastructure/grading/pg-grade-export'
import { err, type Result } from '@/shared/result'
import { taipeiParts } from '@/shared/time'

/**
 * 成績匯出的組裝（票 24）。獨立一個檔：這裡要認人（`resolveActor` → Better Auth），
 * 背景工作不能帶 Better Auth（同 `group-roster.ts` 的理由）。
 */

let exporter: GradeExporter | undefined

export function getGradeExporter(): GradeExporter {
  exporter ??= new PgGradeExporter({ query: getGradebookQuery(), audit: getAuditWriter() })
  return exporter
}

/**
 * `POST /api/admin/grading/export` 的門面：每次重新認人、重新授權（契約 03 §4），授權**先於**驗證
 * （沒登入、不是管理員的人不該從錯誤訊息知道請求格式對不對）。檔名：`成績-<屆別>-<年月日-時分>.csv|xlsx`。
 */
export async function exportGrades(
  headers: Headers,
  body: unknown,
): Promise<Result<{ body: string | Uint8Array; fileName: string; format: 'csv' | 'xlsx'; groupCount: number; rowCount: number }>> {
  const actor = await resolveActor(headers)
  if (actor.kind !== 'authenticated') return err('UNAUTHENTICATED', '請先登入。')
  if (!actor.roles.includes('admin')) return err('FORBIDDEN', '只有系辦可以匯出成績。')
  const request = normalizeGradeExportRequest(body)
  if (!request.ok) return request
  const result = await getGradeExporter().exportGrades(actor, request.value)
  if (!result.ok) return result
  const t = taipeiParts(new Date(result.receipt.serverTime))
  const two = (n: number) => String(n).padStart(2, '0')
  const stamp = `${t.year}${two(t.month)}${two(t.day)}-${two(t.hour)}${two(t.minute)}`
  return {
    ...result,
    receipt: { ...result.receipt, fileName: `成績-${result.receipt.cohortCode}-${stamp}.${result.receipt.format}` },
  }
}
