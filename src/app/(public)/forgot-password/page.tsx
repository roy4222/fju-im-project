import Link from "next/link";
import type { Metadata } from "next";
import { AuthCard, Field } from "@/components/public/auth-card";

export const metadata: Metadata = { title: "忘記密碼", robots: { index: false }, alternates: { canonical: "/forgot-password" } };

/** 忘記密碼（規格 §2.3）：只適用 Email／密碼帳號；寄一次性連結。原型送出後顯示已寄出。 */
export default async function ForgotPasswordPage({ searchParams }: PageProps<"/forgot-password">) {
  const sp = await searchParams;
  const sent = sp.sent === "1";
  return (
    <AuthCard title="忘記密碼" description="只適用 Email／密碼登入的帳號。使用 Google 登入的帳號沒有密碼，直接回登入頁。">
      {sent ? (
        <div className="flex flex-col gap-4">
          <div className="rounded-[10px] bg-secondary p-4.5 text-secondary-foreground">
            <p className="font-bold text-foreground">重設連結已寄出</p>
            <p className="text-[13px] text-muted-foreground">請在 30 分鐘內從信件中的連結設定新密碼。沒收到可再寄一次。</p>
          </div>
          <Link href="/login" className="btn-fju-outline h-11 text-[15px]">回登入頁</Link>
        </div>
      ) : (
        <form action="/forgot-password" className="flex flex-col gap-4.5">
          <input type="hidden" name="sent" value="1" />
          <Field id="email" label="Email" type="email" placeholder="name@mail.fju.edu.tw" hint="會寄一次性重設連結，30 分鐘內有效" required autoComplete="email" />
          <button type="submit" className="btn-fju h-12 text-base">寄送重設連結</button>
          <p className="text-center text-[13px] text-muted-foreground"><Link href="/login" className="font-bold text-brand hover:underline">回登入頁</Link></p>
        </form>
      )}
    </AuthCard>
  );
}
