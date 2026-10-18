import 'server-only'
import type { AvatarCommand } from '@/application/accounts'
import { getAuditWriter, getFileStorage } from '@/composition/ops'
import { getPool } from '@/infrastructure/db/client'
import { PgAvatarCommand } from '@/infrastructure/accounts/avatar-store'

/**
 * 頭像用例的組裝（SH-9）。獨立於 `composition/accounts.ts`（B 設計方案 §2 ▶R-4）：
 * 「我的帳號」（VB-10）與系辦帳號列表（AD-B2）的 action 都從這裡拿，各自先 `currentActor()`。
 */
let avatarCommand: AvatarCommand | undefined

export function getAvatarCommand(): AvatarCommand {
  avatarCommand ??= new PgAvatarCommand({ db: getPool, audit: getAuditWriter(), files: getFileStorage() })
  return avatarCommand
}
