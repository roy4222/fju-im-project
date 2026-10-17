import type { Metadata } from 'next'
import { PublicPage } from '@/app/_ui/public-content'
import { SITE_CONTACT } from '@/app/_ui/site-contact'
import { SiteShell } from '@/app/_ui/site-shell'

export const metadata: Metadata = {
  title: '隱私權政策｜資管系專題平台',
  description: '輔大資管系專題平台蒐集哪些資料、用在哪裡、誰看得到，以及如何聯絡我們。',
  alternates: { canonical: '/privacy' },
}

const H2 = 'text-xl font-extrabold text-foreground'
const P = 'text-[15px] leading-relaxed text-foreground'

/**
 * 隱私權政策（VB-11；AC-VI-70；設計方案 §3.11、§8 R4）。
 *
 * 四段文案照 Roy 定的 R4 草稿；保存年限寫「依校方規定」，不自訂數字；不做 cookie 橫幅。
 * 純靜態、不查資料庫，訪客與登入者看到的相同。聯絡資料讀 `SITE_CONTACT`，不寫死。
 */
export default function PrivacyPage() {
  return (
    <SiteShell current="/privacy" bare>
      <PublicPage title="隱私權政策" description="我們蒐集哪些資料、用在哪裡、誰看得到，以及怎麼聯絡我們。">
        <div className="flex max-w-3xl flex-col gap-9">
          <section aria-labelledby="privacy-collect" className="flex flex-col gap-3">
            <h2 id="privacy-collect" className={H2}>
              我們蒐集哪些資料
            </h2>
            <p className={P}>
              註冊與使用本站時，我們會蒐集你的姓名、學號、系級、手機、Email、登入紀錄，以及用 Google 帳號登入時的 Google 帳號識別。
            </p>
          </section>
          <section aria-labelledby="privacy-use" className="flex flex-col gap-3">
            <h2 id="privacy-use" className={H2}>
              資料用在哪裡
            </h2>
            <p className={P}>
              這些資料用在公告與作業、聯絡、帳號審核與網站統計。網站統計使用 Google Analytics 4，只記錄你的角色（例如訪客、學生、老師），不記錄姓名、Email 或其他個人資料。
            </p>
            <p className={P}>資料的保存年限依校方規定。</p>
          </section>
          <section aria-labelledby="privacy-access" className="flex flex-col gap-3">
            <h2 id="privacy-access" className={H2}>
              誰看得到
            </h2>
            <p className={P}>
              系辦與指導老師看得到學生資料；其他學生只看得到同組內必要的資料；訪客只看得到公開內容。
            </p>
          </section>
          <section aria-labelledby="privacy-contact" className="flex flex-col gap-3" data-testid="privacy-contact">
            <h2 id="privacy-contact" className={H2}>
              聯絡我們
            </h2>
            <p className={P}>對你的資料有任何疑問，請聯絡系辦：</p>
            <address className={`${P} flex flex-col gap-1 not-italic`}>
              <span className="font-bold">{SITE_CONTACT.department}</span>
              <span>{SITE_CONTACT.address}</span>
              <span>
                電話{' '}
                <a href={SITE_CONTACT.phoneHref} className="underline underline-offset-2 hover:text-primary">
                  {SITE_CONTACT.phone}
                </a>
              </span>
            </address>
          </section>
        </div>
      </PublicPage>
    </SiteShell>
  )
}
