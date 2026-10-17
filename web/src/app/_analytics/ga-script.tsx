import { cookies, headers } from 'next/headers'
import Script from 'next/script'
import { renderActor } from '@/app/_ui/guard'
import { gaRole, type GaRole } from './ga-role'
import { OTHER_ROUTE } from './route-names'

/**
 * GA4 載入器（訪客規格 §3.10；Q35／Q36／Q56／Q199）。
 *
 * - 量測 ID 在**執行期**讀 `GA4_MEASUREMENT_ID`：同一個映像檔同時服務測試站與正式站，只有正式站設這個鍵。
 *   沒設（測試站、CI、本機）→ 什麼都不輸出，頁面上沒有任何 Google 的請求。
 * - 不自動送 `page_view`（GA 預設會帶完整網址、referrer、標題）；頁面瀏覽由 `<PageView />` 經 `trackEvent` 送。
 * - 不設 `user_id`；唯一的使用者屬性是角色。沒有登入 cookie 的訪客直接當 `guest`，不解析身分。
 * - 初始化是帶 nonce 的 inline script，HTML 解析到就跑，所以 hydration 後第一個 `page_view` 一定排得進佇列。
 *   gtag 載入器由它自己的 nonce 放行，它再插入的腳本靠 `strict-dynamic`（`script-src` 不用改）。
 */
export async function GaScript() {
  const id = process.env.GA4_MEASUREMENT_ID?.trim()
  if (!id || !/^G-[A-Z0-9]{2,20}$/.test(id)) return null

  const nonce = (await headers()).get('x-nonce') ?? undefined
  const role = await currentRole()
  const config = {
    send_page_view: false,
    page_referrer: '',
    page_title: OTHER_ROUTE,
    user_properties: { role },
  }
  // 值都是上面驗過的 ID 與枚舉；`<` 再逃逸一次，字串怎樣都關不掉 script 標籤。
  const init = [
    'window.dataLayer=window.dataLayer||[];',
    'window.gtag=function(){window.dataLayer.push(arguments)};',
    "gtag('js',new Date());",
    "gtag('set',{allow_google_signals:false,allow_ad_personalization_signals:false});",
    `gtag('config',${JSON.stringify(id)},Object.assign(${JSON.stringify(config)},{page_location:location.origin+${JSON.stringify(OTHER_ROUTE)}}));`,
  ]
    .join('')
    .replace(/</g, '\\u003c')

  return (
    <>
      <script id="ga-init" nonce={nonce} dangerouslySetInnerHTML={{ __html: init }} />
      <Script
        id="ga-loader"
        nonce={nonce}
        src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`}
        strategy="afterInteractive"
      />
    </>
  )
}

async function currentRole(): Promise<GaRole> {
  const hasSession = (await cookies()).getAll().some((cookie) => cookie.name.endsWith('better-auth.session_token'))
  if (!hasSession) return 'guest'
  // 跟頁面、外殼共用同一次身分解析（React cache，請求範圍）。
  return gaRole(await renderActor())
}
