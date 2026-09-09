import Link from "next/link";
import type { Metadata } from "next";
import { AuthCard, Field } from "@/components/public/auth-card";
import { GoogleIcon } from "@/components/public/google-icon";

export const metadata: Metadata = { title: "註冊", alternates: { canonical: "/register" } };

/** 註冊（規格 §2.4）：姓名、學號、屆別、手機、聯絡 Email；不收生日與照片。原型送出後到等待審核頁。 */
export default function RegisterPage() {
  return (
    <AuthCard title="註冊" description="請用學籍姓名與學號。老師帳號由系辦建立。" width="max-w-[560px]">
      <form action="/register/pending" className="flex flex-col gap-4">
        <button type="button" className="inline-flex h-12 items-center justify-center gap-2.5 rounded-md border border-border font-bold transition-colors hover:bg-accent">
          <GoogleIcon /> 使用 Google 帳號註冊
        </button>
        <div className="flex items-center gap-3 text-[13px] text-muted-foreground"><span className="h-px flex-1 bg-border" />或填寫 Email 與密碼<span className="h-px flex-1 bg-border" /></div>
        <div className="grid gap-3.5 sm:grid-cols-2">
          <Field id="name" label="姓名" placeholder="與學籍相同" required autoComplete="name" />
          <Field id="studentNo" label="學號" placeholder="411410123" required />
        </div>
        <div className="grid gap-3.5 sm:grid-cols-2">
          <Field id="cohort" label="屆別／專題年度" placeholder="114 學年度" required />
          <Field id="phone" label="手機" placeholder="09xx-xxx-xxx" required autoComplete="tel" />
        </div>
        <Field id="email" label="聯絡 Email" type="email" placeholder="name@mail.fju.edu.tw" required autoComplete="email" />
        <div className="grid gap-3.5 sm:grid-cols-2">
          <Field id="password" label="密碼" type="password" placeholder="至少 12 字元" autoComplete="new-password" />
          <Field id="password2" label="確認密碼" type="password" autoComplete="new-password" />
        </div>
        <button type="submit" className="btn-fju h-12 text-base">建立帳號</button>
        <p className="text-center text-[13px] text-muted-foreground">已有帳號？<Link href="/login" className="font-bold text-brand hover:underline">登入</Link></p>
      </form>
    </AuthCard>
  );
}
