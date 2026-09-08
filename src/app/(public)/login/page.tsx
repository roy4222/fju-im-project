import Link from "next/link";
import type { Metadata } from "next";
import { GoogleIcon } from "@/components/public/google-icon";
import { AuthCard, Field } from "@/components/public/auth-card";

export const metadata: Metadata = { title: "登入", alternates: { canonical: "/login" }, robots: { index: false } };

/**
 * 登入：Google 主用、Email／密碼備援（規格 §2.3）。
 * 原型：兩顆按鈕都只是把身分切成學生（POST /api/proto-role），沒有真正驗證。
 */
export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const sp = await searchParams;
  const returnTo = typeof sp.returnTo === "string" && sp.returnTo.startsWith("/") ? sp.returnTo : "/";
  return (
    <AuthCard title="登入" description="學生、老師與系辦使用同一個入口，登入後依角色進入平台。">
      <form method="post" action="/api/proto-role" className="flex flex-col gap-4.5">
        <input type="hidden" name="role" value="student" />
        <input type="hidden" name="returnTo" value={returnTo} />
        <button type="submit" className="inline-flex h-12 items-center justify-center gap-2.5 rounded-md border border-border font-bold transition-colors hover:bg-accent">
          <GoogleIcon /> 使用 Google 帳號登入
        </button>
        <div className="flex items-center gap-3 text-[13px] text-muted-foreground"><span className="h-px flex-1 bg-border" />或使用 Email 與密碼<span className="h-px flex-1 bg-border" /></div>
        <Field id="email" label="Email" type="email" placeholder="name@mail.fju.edu.tw" autoComplete="email" />
        <Field id="password" label="密碼" type="password" placeholder="••••••••" autoComplete="current-password" trailing={<Link href="/forgot-password" className="text-[13px] font-semibold text-brand hover:underline">忘記密碼</Link>} />
        <button type="submit" className="btn-fju h-12 text-base">登入</button>
        <p className="text-center text-[13px] text-muted-foreground">
          還沒有帳號？<Link href="/register" className="font-bold text-brand hover:underline">註冊</Link>　本屆名單命中者自動核准，其餘由系辦審核。
        </p>
        <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">原型：按任一登入鈕會以「學生」身分登入；要看老師或管理員，用右下角操作列切換。</p>
      </form>
    </AuthCard>
  );
}
