import Link from 'next/link'
import { IconMapPinOff } from '@tabler/icons-react'
import { currentActor, homeFor } from '@/app/_ui/guard'
import { CodeNotice } from '@/app/_ui/public-content'
import { SiteShell } from '@/app/_ui/site-shell'

export const metadata = { title: '找不到這個頁面｜資管系專題平台' }

/**
 * 拒絕頁：角色不對（guard）、老師開別人的評分或簽核頁、別屆或已下架的附件都導到這裡。
 * 沒權限就不要出現（2026-09-26）：畫面跟 404 頁一樣是「找不到這個頁面」，不說沒有權限、不放鎖頭、不透露原因。
 * 2026-10-12 Roy Q35 推翻 T11 保留 403 畫面的決定；導向 `/403` 的機制不變，只換內容。
 * 跟 404 頁唯一的差別是按鈕指回自己的首頁（登入的人才會到這裡）。
 */
export default async function ForbiddenPage() {
  const actor = await currentActor()
  return (
    <SiteShell>
      <CodeNotice
        code="404"
        icon={<IconMapPinOff className="size-7" aria-hidden />}
        title="找不到這個頁面"
        data-testid="not-found"
        actions={
          <Link href={homeFor(actor)} className="btn-fju h-11.5 px-7 text-[15px]">
            回到自己的首頁
          </Link>
        }
      >
        網址可能打錯了，或這個內容已經下架。
      </CodeNotice>
    </SiteShell>
  )
}
