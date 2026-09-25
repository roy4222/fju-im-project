import 'server-only'
import { headers } from 'next/headers'
import { cache } from 'react'
import { redirect } from 'next/navigation'
import type { Capability, ResolvedActor, Role } from '@/application/accounts'
import {
  actorHasRole,
  checkStatus,
  getTeacherSetupCommand,
  resolveActor,
  TEACHER_SETUP_PATH,
} from '@/composition/accounts'

/**
 * 頁面層的授權導向（契約 03 §1：授權判斷在用例層，頁面只做導向）。
 *
 * 頁面做的事只有三件：看不看得到這一頁、看不到要往哪裡去、以及畫面要顯示什麼。
 * **真正的授權在每個用例裡再判一次**——頁面通過不代表用例會放行，
 * 直接打 Server Action 或 Route Handler 的人繞不過那一層。
 */

/** 這次請求是誰。沒登入回 `anonymous`。 */
export async function currentActor(): Promise<ResolvedActor> {
  return resolveActor(await headers())
}

/**
 * 外殼（頂列頭像、通知鈴鐺）用的「這次請求是誰」：同一次渲染只解析一次，頭像與鈴鐺共用。
 *
 * 刻意**不**把 `currentActor` 本身包 `cache`：Server Action 會在同一個請求裡先改狀態
 * （改密、登出）再重畫，快取住的舊身分可能被拿去做判斷。這裡只給顯示用，不做授權。
 */
export const shellViewer = cache(currentActor)

/** 三種後台各自的首頁；403 頁的「回到自己的首頁」也用這個。 */
export function homeFor(actor: ResolvedActor): string {
  if (actor.kind !== 'authenticated') return '/'
  if (actorHasRole(actor, 'admin')) return '/dashboard/admin'
  if (actorHasRole(actor, 'teacher')) return '/dashboard/teacher'
  if (actorHasRole(actor, 'student')) return '/dashboard/student'
  // 已登入但還沒有任何角色＝待審核中。
  return '/register/pending'
}

/**
 * 需要登入才能看的頁面。
 *
 * 未登入導 `/login?next=…`，讓人登入完回得到原本要去的地方；
 * 帳號狀態擋下時導到對應的頁（待審核、必須改密）而不是丟一個錯誤頁。
 */
export async function requireSignedIn(pathname: string, capability: Capability = 'business') {
  const actor = await currentActor()
  if (actor.kind === 'anonymous') redirect(`/login?next=${encodeURIComponent(pathname)}`)

  const blocked = checkStatus(actor, capability)
  if (blocked === 'UNAUTHENTICATED') redirect(`/login?next=${encodeURIComponent(pathname)}`)
  if (blocked === 'PASSWORD_CHANGE_REQUIRED') redirect('/account/change-password')
  if (blocked === 'ACCOUNT_PENDING') redirect('/register/pending')

  return actor
}

/**
 * 需要某個角色的後台。
 *
 * 角色不對時**導到 `/403`**，而不是在 layout 裡改渲染一個 403 畫面。
 * 這不是風格選擇，是安全問題：App Router 的 layout 與它底下的 page 是**並行渲染**的，
 * layout 就算把 `children` 丟掉不顯示，那一頁仍然會被渲染，內容會跟著 RSC payload
 * 一起送到瀏覽器——畫面上看不到，但 view-source 看得到。
 * （這個洞是 e2e 的「學生 cookie 直接 GET 管理頁」那條測試抓出來的，該條測試留著當回歸。）
 *
 * `redirect()` 會中止整個回應，瀏覽器拿到的是 3xx，沒有任何頁面內容。
 */
export async function requireRole(pathname: string, role: Role) {
  const actor = await requireSignedIn(pathname)
  if (!actorHasRole(actor, role)) redirect('/403')
  // 老師第一次登入要先補姓名與聯絡資料（票 8）：所有老師頁都經這裡，補完才放行。
  if (role === 'teacher' && actor.kind === 'authenticated' && (await getTeacherSetupCommand().needsSetup(actor.userId))) {
    redirect(TEACHER_SETUP_PATH)
  }
  return actor
}
