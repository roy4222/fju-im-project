import type { Metadata } from "next";
import { AuthAside, AuthSplit } from "@/components/public/auth-split";
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
    <AuthSplit
      aside={
        <AuthAside
          eyebrow="資管系專題平台"
          title="專題事務、繳交與審核，都在這裡"
          photo="/placeholder/atrium.jpg"
          photoAlt="輔仁大學校園"
          steps={[
            { title: "學生", body: "看本週要交什麼、繳交文件、確認分組與指導老師。" },
            { title: "老師", body: "看待指導的組別、簽核與評分。" },
            { title: "系辦", body: "發布收件項目、審核帳號、追蹤逾期組別。" },
          ]}
          footnote="學生、老師與系辦使用同一個入口；老師帳號由系辦建立。"
        />
      }
    >
      <LoginCard initial={{ mode, email: one(sp.email) || (error || mode !== "login" ? "411410488@m365.fju.edu.tw" : ""), error }} returnTo={returnTo} />
    </AuthSplit>
  );
}
