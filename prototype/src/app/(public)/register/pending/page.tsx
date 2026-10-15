import type { Metadata } from "next";
import { AuthSplit } from "@/components/public/auth-split";
import { PendingStatus, type ReviewState } from "./pending-status";

export const metadata: Metadata = { title: "等待審核", robots: { index: false }, alternates: { canonical: "/register/pending" } };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/**
 * 待審頁 v2（名單未命中、或用 Email 註冊）。註冊送出時把資料帶在網址上；直接開則用示範資料。
 * ?state=pending|rejected|approved、?edited=1 可直接看各狀態（原型截圖用）。
 */
export default async function PendingPage({ searchParams }: PageProps<"/register/pending">) {
  const sp = await searchParams;
  const raw = one(sp.state);
  const state: ReviewState = raw === "rejected" || raw === "approved" ? raw : "pending";
  const profile = {
    name: one(sp.name) || "許庭瑋",
    studentNo: one(sp.studentNo) || "411410466",
    className: one(sp.className) || "資管四甲",
    phone: one(sp.phone) || "0912-345-678",
    email: one(sp.email) || "tingwei.hsu@gmail.com",
  };
  return (
    <AuthSplit photo="/placeholder/building.jpg" photoAlt="輔仁大學校園建築" width="max-w-[520px]">
      <PendingStatus initial={{ state, profile, submittedAt: "2026-10-15 14:32", editedAt: one(sp.edited) === "1" ? "2026-10-15 16:05" : null }} />
    </AuthSplit>
  );
}
