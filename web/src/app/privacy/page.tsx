import type { Metadata } from 'next'
import { feItem, frontEditScope } from '@/app/_ui/front-edit/mark'
import { PublicPage } from '@/app/_ui/public-content'
import { resolveSiteContact } from '@/app/_ui/site-contact'
import { SiteShell } from '@/app/_ui/site-shell'
import type { PrivacyText } from '@/application/site'
import { loadSiteTexts, privacyBodyOf } from '@/composition/site'

export const metadata: Metadata = {
  title: '隱私權政策｜資管系專題平台',
  description: '輔大資管系專題平台蒐集哪些資料、用在哪裡、誰看得到，以及如何聯絡我們。',
  alternates: { canonical: '/privacy' },
}

const H2 = 'text-xl font-extrabold text-foreground'
const P = 'text-[15px] leading-relaxed text-foreground'

/** 系辦還沒改過時的內文（Roy 定的 R4 草稿，跟改版前一字不差）；也是編輯表單第一次打開的預填。 */
export const PRIVACY_DEFAULT: PrivacyText = {
  sections: [
    {
      heading: '我們蒐集哪些資料',
      paragraphs: ['註冊與使用本站時，我們會蒐集你的姓名、學號、系級、手機、Email、登入紀錄，以及用 Google 帳號登入時的 Google 帳號識別。'],
    },
    {
      heading: '資料用在哪裡',
      paragraphs: [
        '這些資料用在公告與作業、聯絡、帳號審核與網站統計。網站統計使用 Google Analytics 4，只記錄你的角色（例如訪客、學生、老師），不記錄姓名、Email 或其他個人資料。',
        '資料的保存年限依校方規定。',
      ],
    },
    {
      heading: '誰看得到',
      paragraphs: ['系辦與指導老師看得到學生資料；其他學生只看得到同組內必要的資料；訪客只看得到公開內容。'],
    },
  ],
}

/**
 * 隱私權政策（VB-11；AC-VI-70；設計方案 §3.11、§8 R4）。
 *
 * 內文段落讀 `site_texts.privacy`（C2-17；系辦在前台改），沒有列就是 Roy 定的 R4 草稿；
 * 保存年限寫「依校方規定」，不自訂數字；不做 cookie 橫幅。訪客與登入者看到的相同。
 * 「聯絡我們」那一節由程式接頁尾聯絡資料（`site_texts.footer_contact`，沒有就是 `SITE_CONTACT`），不在內文表單裡。
 */
export default async function PrivacyPage() {
  // 前台編輯標記（C2-16）：只有系辦經 /office-edit 改寫進來才有（看改寫標頭，訪客不多查身分）。整頁內文一則、只能改不能刪。
  const fe = await frontEditScope()
  const texts = await loadSiteTexts()
  const privacy = texts.privacy?.value ?? PRIVACY_DEFAULT
  const contact = resolveSiteContact(texts.footer_contact?.value)
  return (
    <SiteShell current="/privacy" bare>
      <PublicPage title="隱私權政策" description="我們蒐集哪些資料、用在哪裡、誰看得到，以及怎麼聯絡我們。">
        <div
          className="flex max-w-3xl flex-col gap-9"
          {...feItem(fe, { kind: 'privacy', id: 'privacy', rev: texts.privacy?.revision ?? 0, fields: { title: '隱私權政策', body: privacyBodyOf(privacy) } })}
        >
          {privacy.sections.map((section, index) => (
            <section key={`${index}-${section.heading}`} aria-labelledby={`privacy-section-${index}`} className="flex flex-col gap-3">
              <h2 id={`privacy-section-${index}`} className={H2}>
                {section.heading}
              </h2>
              {section.paragraphs.map((paragraph) => (
                <p key={paragraph} className={P}>
                  {paragraph}
                </p>
              ))}
            </section>
          ))}
          <section aria-labelledby="privacy-contact" className="flex flex-col gap-3" data-testid="privacy-contact">
            <h2 id="privacy-contact" className={H2}>
              聯絡我們
            </h2>
            <p className={P}>對你的資料有任何疑問，請聯絡系辦：</p>
            <address className={`${P} flex flex-col gap-1 not-italic`}>
              <span className="font-bold">{contact.department}</span>
              <span>{contact.address}</span>
              <span>
                電話{' '}
                <a href={contact.phoneHref} className="underline underline-offset-2 hover:text-primary">
                  {contact.phone}
                </a>
              </span>
            </address>
          </section>
        </div>
      </PublicPage>
    </SiteShell>
  )
}
