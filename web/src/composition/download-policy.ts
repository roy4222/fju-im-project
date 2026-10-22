import 'server-only'
import type { FilePurpose } from '@/application/ops'

/**
 * 帳號狀態被擋（待審、必須改密）的登入者比照訪客時，還能走訪客政策的用途（#635、⑤-02）。
 *
 * 首頁大圖、公告封面與附件、精選海報：訪客拿得到的，被擋的人也拿得到；其他用途一律「無法存取」。
 * 正式組裝（`composition/ops.ts`）與整合測試都讀這一份，別的地方不准另外注入字面值（契約 X-⑤-4）。
 * 獨立成檔是為了讓整合測試 import 時不必載入 `composition/ops.ts` 的整套組裝（vitest 把 `server-only` 換成空殼）。
 */
export const PUBLIC_READ_PURPOSES: readonly FilePurpose[] = ['photo', 'attachment', 'poster']
