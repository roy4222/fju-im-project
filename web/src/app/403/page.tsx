import Link from 'next/link'
import { IconLock } from '@tabler/icons-react'
import { currentActor, homeFor } from '@/app/_ui/guard'
import { CodeNotice } from '@/app/_ui/public-content'
import { SiteShell } from '@/app/_ui/site-shell'

export const metadata = { title: '沒有權限｜資管系專題平台' }

/**
 * 統一的 403 頁；一定要給下一步，不能只說「沒有權限」。
 * 外觀照原型 `/403`（大數字、鎖頭、一句標題、兩顆按鈕）；原型那頁是「需要登入」，這裡是「角色不對」，文案照正式碼。
 */
export default async function ForbiddenPage() {
  const actor = await currentActor()
  return (
    <SiteShell>
      <CodeNotice
        code="403"
        icon={<IconLock className="size-7" aria-hidden />}
        title="這一頁不是給你的角色看的"
        actions={
          <>
            <Link href={homeFor(actor)} className="btn-fju h-11.5 px-7 text-[15px]">
              回到自己的首頁
            </Link>
            <Link href="/" className="btn-fju-outline h-11.5 px-7 text-[15px]">
              回前台首頁
            </Link>
          </>
        }
      >
        你的帳號沒有開啟這一頁的權限。如果覺得這是錯的，請聯絡系辦。
      </CodeNotice>
    </SiteShell>
  )
}
