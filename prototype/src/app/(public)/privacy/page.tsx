import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "隱私權政策", alternates: { canonical: "/privacy" } };

/** 隱私權政策（佔位）：正式內容待系辦提供。 */
export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-14 sm:py-20">
      <p className="text-[13px] font-bold tracking-[0.12em] text-brand">POLICY</p>
      <h1 className="mt-2 text-[32px] leading-tight font-extrabold">隱私權政策</h1>
      <p className="mt-2 text-sm text-muted-foreground">最後更新：2026-10-15（佔位內容，正式條文待系辦提供）</p>
      <div className="mt-10 flex flex-col gap-8 text-[15px] leading-loose text-foreground/90">
        <section>
          <h2 className="text-lg font-bold">我們蒐集哪些資料</h2>
          <p className="mt-2">註冊時填寫的姓名、學號、系級、手機與 Email，以及使用 Google 登入時由 Google 提供的姓名與 Email。不蒐集生日與照片。</p>
        </section>
        <section>
          <h2 className="text-lg font-bold">資料用在哪裡</h2>
          <p className="mt-2">只用於資訊管理學系專題課程：核對修課身分、分組、繳交與審核紀錄，以及寄送截止提醒與審核結果通知。</p>
        </section>
        <section>
          <h2 className="text-lg font-bold">誰看得到</h2>
          <p className="mt-2">系辦與你的指導老師看得到你的資料；同組組員看得到彼此的姓名與學號。不提供給系外第三方。</p>
        </section>
        <section>
          <h2 className="text-lg font-bold">聯絡我們</h2>
          <p className="mt-2">對個人資料有疑問，請洽資管系辦公室（利瑪竇大樓 LM306）或來信 <a href="mailto:im@mail.fju.edu.tw" className="font-semibold underline underline-offset-2">im@mail.fju.edu.tw</a>。</p>
        </section>
      </div>
      <Link href="/register" className="btn-fju-outline mt-12 h-11 px-6 text-[15px]">回到註冊</Link>
    </div>
  );
}
