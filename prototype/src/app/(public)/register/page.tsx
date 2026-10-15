import type { Metadata } from "next";
import { AuthSplit } from "@/components/public/auth-split";
import { DEMO_GOOGLE_ACCOUNTS, ROSTER_114 } from "@/lib/fixtures";
import { RegisterFlow, type Step, type Via } from "./register-flow";

export const metadata: Metadata = { title: "註冊", alternates: { canonical: "/register" } };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/**
 * 註冊 v2（Q53／Q54，2026-10-15）：三步驟、左右分割。
 * 網址可帶 ?step=1|2|3|done&via=email|google&email=…&name=… 直接進到某一步（原型截圖與示範用）。
 */
export default async function RegisterPage({ searchParams }: PageProps<"/register">) {
  const sp = await searchParams;
  const rawStep = one(sp.step);
  const step: Step = rawStep === "2" ? 2 : rawStep === "3" ? 3 : rawStep === "done" ? "done" : 1;
  const via: Via = one(sp.via) === "google" ? "google" : "email";
  const fallbackEmail = via === "google" ? DEMO_GOOGLE_ACCOUNTS[0].email : step === 1 ? "" : "yiting.lin@gmail.com";
  return (
    <AuthSplit>
      <RegisterFlow
        initial={{ step, via, email: one(sp.email) || fallbackEmail, name: one(sp.name) || (via === "google" ? DEMO_GOOGLE_ACCOUNTS[0].name : "") }}
        rosterEmails={ROSTER_114.map((r) => r.email)}
        googleAccounts={DEMO_GOOGLE_ACCOUNTS}
      />
    </AuthSplit>
  );
}
