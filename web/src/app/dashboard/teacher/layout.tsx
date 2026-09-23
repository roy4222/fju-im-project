import type { ReactNode } from 'react'
import { requireSignedIn } from '@/app/_ui/guard'

/**
 * 老師後台的第一道：**要登入**。
 *
 * 角色檢查刻意**不**放在這裡，而是在每一頁自己做（見 `_nav.ts` 的 `PROTECTED_ROUTES`
 * 與 `requireRole` 的說明）：App Router 會把 layout 與底下的 page 並行渲染，
 * layout 就算 redirect，那一頁也已經被做出來、內容跟著 payload 送到瀏覽器了。
 * 這一層只負責「沒登入就別進來」，真正的角色邊界由頁面守。
 */
export default async function TeacherLayout({ children }: { children: ReactNode }) {
  await requireSignedIn('/dashboard/teacher', 'self.session')
  return <>{children}</>
}
