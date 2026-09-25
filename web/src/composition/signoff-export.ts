import 'server-only'
import type { SignoffExportFile, SignoffExportFormat } from '@/application/signoff'
import { resolveActor } from '@/composition/accounts'
import { getSignoffCommand } from '@/composition/signoff'
import type { Result } from '@/shared/result'

/**
 * 簽核匯出的門面（票 26；契約 02 §2「匯出：Route Handler，每次授權」）。
 *
 * 獨立一個檔、不放在 `composition/signoff.ts`：這裡要認人（`resolveActor` → Better Auth），
 * 而 `composition/signoff.ts` 會經分組的組裝被背景工作打包進去，worker 不能帶 Better Auth（同 `group-roster.ts`）。
 */
export async function exportSignoffVersion(headers: Headers, versionId: string, format: SignoffExportFormat): Promise<Result<SignoffExportFile>> {
  const actor = await resolveActor(headers)
  return getSignoffCommand().exportVersion(actor, { versionId, format })
}
