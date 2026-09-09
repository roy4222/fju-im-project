import Link from "next/link";
import type { Metadata } from "next";
import { IconClock } from "@tabler/icons-react";
import { AuthCard } from "@/components/public/auth-card";

export const metadata: Metadata = { title: "等待審核", robots: { index: false }, alternates: { canonical: "/register/pending" } };

/** 名單未命中時的說明頁（規格 §2.4：不阻擋送件，進管理員待審）。 */
export default function PendingPage() {
  return (
    <AuthCard title="等待審核" description="帳號已建立，尚未開通。">
      <div className="flex items-start gap-3.5 rounded-[10px] bg-secondary p-4.5 text-secondary-foreground">
        <IconClock className="mt-0.5 size-5 shrink-0 text-brand" aria-hidden />
        <div>
          <p className="font-bold text-foreground">帳號等待系辦審核</p>
          <p className="text-[13px] text-muted-foreground">你的學號或姓名未命中本屆名單，系辦會在 2 個工作天內核對。</p>
        </div>
      </div>
      <dl className="flex flex-col gap-2 text-sm">
        {[["姓名", "林彥廷"], ["學號", "411410123"], ["送出時間", "2026-09-07 14:32"]].map(([k, v]) => (
          <div key={k} className="flex justify-between"><dt className="text-muted-foreground">{k}</dt><dd className="font-semibold">{v}</dd></div>
        ))}
      </dl>
      <p className="text-[13px] leading-relaxed text-muted-foreground">核准後會寄通知到聯絡 Email。若資料填錯，請到系辦公室（利瑪竇大樓）或來信 im@mail.fju.edu.tw。</p>
      <Link href="/" className="btn-fju-outline h-11 text-[15px]">回到首頁</Link>
    </AuthCard>
  );
}
