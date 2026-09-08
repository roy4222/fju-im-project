import type { Metadata } from "next";
import { PageHead, Tag } from "@/components/public/blocks";
import { NeedLogin } from "@/components/public/need-login";
import { ROLE_LABEL, getViewer } from "@/lib/data/viewer";
import { MY_GROUP } from "@/lib/fixtures";

export const metadata: Metadata = { title: "個人資料", robots: { index: false }, alternates: { canonical: "/account" } };

function Field({ label, value, hint, readOnly = false }: { label: string; value: string; hint?: string; readOnly?: boolean }) {
  const id = `f-${label}`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-semibold">{label}</label>
      <input id={id} defaultValue={value} readOnly={readOnly} className={`h-11 rounded-md border border-input px-3 text-sm ${readOnly ? "bg-muted text-muted-foreground" : "bg-background"}`} />
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

export default async function AccountPage() {
  const viewer = await getViewer();
  if (!viewer.isMember || !viewer.user) return <NeedLogin returnTo="/account" what="個人資料" />;
  const u = viewer.user;
  return (
    <>
      <PageHead title="個人資料" description="學號與屆別由系辦維護。" crumbs={[{ label: "個人資料" }]} />
      <div className="mx-auto grid max-w-6xl gap-12 px-5 py-10 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex flex-col gap-6">
          <form className="flex flex-col gap-4.5 rounded-xl border border-border bg-card p-7">
            <h2 className="text-lg font-bold">基本資料</h2>
            <div className="grid gap-3.5 sm:grid-cols-2">
              <Field label="姓名" value={u.name} />
              {u.studentNo ? <Field label="學號" value={u.studentNo} readOnly hint="由系辦維護" /> : <Field label="身分" value={ROLE_LABEL[viewer.role]} readOnly />}
            </div>
            <div className="grid gap-3.5 sm:grid-cols-2">
              <Field label="屆別" value="114 學年度" readOnly hint="由系辦維護" />
              <Field label="手機" value="0912-345-678" />
            </div>
            <Field label="聯絡 Email" value={u.email} hint="系統通知寄到這裡" />
            <button type="button" className="btn-fju h-11 self-start px-5 text-[15px]">儲存變更</button>
          </form>
          <section className="flex flex-col gap-3.5 rounded-xl border border-border bg-card p-7" aria-label="登入方式">
            <h2 className="text-lg font-bold">登入方式</h2>
            <div className="flex items-center justify-between border-b border-border py-3">
              <span className="font-semibold">Google　<span className="font-normal text-muted-foreground">{u.email}</span></span>
              <Tag tone="navy">已連結</Tag>
            </div>
            <div className="flex items-center justify-between py-3">
              <span className="font-semibold">Email／密碼　<span className="font-normal text-muted-foreground">最後修改 2026-08-01</span></span>
              <a href="/forgot-password" className="font-semibold text-brand hover:underline">更改密碼</a>
            </div>
          </section>
        </div>
        <aside className="flex flex-col gap-4">
          <div className="flex flex-col gap-2 rounded-xl bg-secondary p-5.5 text-secondary-foreground">
            <p className="font-bold text-foreground">帳號狀態</p>
            <Tag tone="navy" className="self-start">已核准・{ROLE_LABEL[viewer.role]}</Tag>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {viewer.role === "student" ? `2026-08-14 由名單自動核准。${MY_GROUP.no}組長。` : "由系辦建立並授予角色。"}
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}
