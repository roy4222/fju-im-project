import type { Metadata } from 'next'
import { PublicPage } from '@/app/_ui/public-content'
import { SiteShell } from '@/app/_ui/site-shell'

export const metadata: Metadata = {
  title: '隱私權政策｜資管系專題平台',
  description: '輔大資管系專題平台如何蒐集、使用、保存與保護你的個人資料。',
  alternates: { canonical: '/privacy' },
}

/** 四段文案照 Roy 定案的 R4 草稿；保存年限一律寫「依校方規定」，不自訂數字。 */
const SECTIONS = [
  {
    id: 'collect',
    title: '我們蒐集哪些資料',
    body: [
      '註冊與登入時，我們會蒐集你的姓名、學校 Email、學號（學生）與密碼（加密後儲存，我們看不到原文）。',
      '使用平台時，會留下你提交的專題資料、分組紀錄、成績與操作紀錄；為了了解網站使用狀況，也會以 Google Analytics 蒐集匿名的瀏覽統計。',
    ],
  },
  {
    id: 'use',
    title: '我們如何使用這些資料',
    body: [
      '資料只用在專題課程的教學與行政：確認身分、分組與指導、成績評定、寄送通知，以及改善網站。',
      '我們不會把你的資料出售或提供給與專題課程無關的第三方。',
    ],
  },
  {
    id: 'retention',
    title: '資料保存與保護',
    body: [
      '資料的保存年限依校方規定；超過年限後會刪除或去識別化。',
      '資料存放在受權限控管的系統，只有課程相關的教師與系辦人員，能依職務看到必要的部分。',
    ],
  },
  {
    id: 'rights',
    title: '你的權利與聯絡方式',
    body: [
      '你可以隨時查詢、更正自己的資料，也可以申請刪除；依法或校方規定必須保留的資料除外。',
      '有任何問題，請聯絡輔仁大學資訊管理學系系辦。',
    ],
  },
] as const

/** 隱私權政策（VB-11；AC-VI-70）。純靜態、不查資料庫，訪客與登入者看到的相同。 */
export default function PrivacyPage() {
  return (
    <SiteShell current="/privacy" bare>
      <PublicPage title="隱私權政策" description="我們如何蒐集、使用、保存與保護你的個人資料。">
        <div className="flex max-w-3xl flex-col gap-9">
          {SECTIONS.map((s, index) => (
            <section key={s.id} aria-labelledby={`privacy-${s.id}`} className="flex flex-col gap-3">
              <h2 id={`privacy-${s.id}`} className="text-xl font-extrabold text-foreground">
                {index + 1}. {s.title}
              </h2>
              {s.body.map((p) => (
                <p key={p} className="text-[15px] leading-relaxed text-foreground">
                  {p}
                </p>
              ))}
            </section>
          ))}
        </div>
      </PublicPage>
    </SiteShell>
  )
}
