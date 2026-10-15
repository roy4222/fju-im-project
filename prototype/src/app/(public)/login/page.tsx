import type { Metadata } from "next";
import { AuthSplit } from "@/components/public/auth-split";
import { LoginCard, type LoginMode } from "./login-card";

export const metadata: Metadata = { title: "登入", alternates: { canonical: "/login" }, robots: { index: false } };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/**
 * 登入 v2：Google 主用、Email／密碼備援（規格 §2.3），忘記密碼在同一張卡片切換。
 * ?mode=forgot|sent、?error=1&email=… 可直接看各狀態（原型截圖用）。
 */
export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const sp = await searchParams;
  const rawReturn = one(sp.returnTo);
  const returnTo = rawReturn.startsWith("/") && !rawReturn.startsWith("//") ? rawReturn : "/";
  const rawMode = one(sp.mode);
  const mode: LoginMode = rawMode === "forgot" || rawMode === "sent" ? rawMode : "login";
  const error = one(sp.error) === "1";
  return (
    <AuthSplit photo="/placeholder/atrium.jpg">
      <LoginCard initial={{ mode, email: one(sp.email) || (error || mode !== "login" ? "411410488@m365.fju.edu.tw" : ""), error }} returnTo={returnTo} />
    </AuthSplit>
  );
}
