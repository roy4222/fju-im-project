"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { IconAlertTriangleFilled, IconCheck, IconId, IconMapPin, IconPencil } from "@tabler/icons-react";
import { DemoBox, TextField, nowStamp } from "@/components/public/auth-fields";

export type ReviewState = "pending" | "rejected" | "approved";
export type Profile = { name: string; studentNo: string; className: string; phone: string; email: string };

const rejectReason = (p: Profile) => `學號 ${p.studentNo} 在本屆專題名單上的姓名和你填的「${p.name}」不同。請確認後修改資料重新送出，或帶學生證到系辦核對。`;

/**
 * 待審頁 v2：已送出 → 系辦審核中 → 已開通／被退回。
 * 修改資料後只顯示「已編輯・時間」，不顯示第幾版或修改紀錄（Roy 10/15）。
 */
export function PendingStatus({ initial }: { initial: { state: ReviewState; profile: Profile; submittedAt: string; editedAt: string | null } }) {
  const [state, setState] = useState<ReviewState>(initial.state);
  const [profile, setProfile] = useState(initial.profile);
  const [editedAt, setEditedAt] = useState(initial.editedAt);
  const [editing, setEditing] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const editBtnRef = useRef<HTMLButtonElement>(null);
  const formHeadingRef = useRef<HTMLHeadingElement>(null);
  const wasEditing = useRef(false);

  useEffect(() => {
    if (editing) formHeadingRef.current?.focus();
    else if (wasEditing.current) editBtnRef.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const get = (k: string) => String(fd.get(k) ?? "").trim();
    const next: Record<string, string> = {};
    if (!get("name")) next.name = "請填姓名";
    if (!/^\d{9}$/.test(get("studentNo"))) next.studentNo = "學號是 9 位數字";
    if (!get("className")) next.className = "請填系級";
    if (!/^09\d{2}-?\d{3}-?\d{3}$/.test(get("phone"))) next.phone = "手機格式像 0912-345-678";
    setErrors(next);
    if (Object.keys(next).length) return;
    setProfile({ ...profile, name: get("name"), studentNo: get("studentNo"), className: get("className"), phone: get("phone") });
    setEditedAt(nowStamp());
    // 被退回後修改＝重新送出，回到審核中
    if (state === "rejected") setState("pending");
    setEditing(false);
  }

  const steps = [
    { label: "已送出", sub: initial.submittedAt, status: "done" as const },
    state === "pending"
      ? { label: "系辦審核中", sub: "通常 1～3 個工作天", status: "current" as const }
      : { label: "系辦審核", sub: state === "rejected" ? "需要修改資料" : "已核對", status: "done" as const },
    state === "approved"
      ? { label: "已開通", sub: "可以登入使用", status: "done" as const }
      : state === "rejected"
        ? { label: "被退回", sub: "請看下方理由", status: "error" as const }
        : { label: "已開通／被退回", sub: "結果會寄到你的 Email", status: "todo" as const },
  ];

  const title = state === "approved" ? "帳號已開通" : state === "rejected" ? "資料被退回" : "等待系辦審核";
  const desc =
    state === "approved"
      ? "系辦已核對完成，現在可以登入使用。"
      : state === "rejected"
        ? "系辦核對時發現資料和名單不一致，修改後會重新進入審核。"
        : "帳號已建立，系辦核對身分後就會開通，結果會寄到你的 Email。";

  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-[28px] leading-tight font-extrabold">{title}</h1>
        <p className="text-[15px] leading-relaxed text-muted-foreground">{desc}</p>
      </div>

      <ol className="flex flex-col" aria-label="審核進度">
        {steps.map((s, i) => (
          <li key={s.label} className="relative flex gap-3.5 pb-5 last:pb-0" aria-current={s.status === "current" ? "step" : undefined}>
            {i < steps.length - 1 ? <span aria-hidden className={`absolute top-8 bottom-0 left-[15px] w-0.5 ${s.status === "done" ? "bg-brand" : "bg-border"}`} /> : null}
            <span
              className={`flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
                s.status === "done" ? "bg-brand text-brand-foreground" : s.status === "current" ? "bg-brand-subtle text-brand-on-subtle ring-2 ring-brand" : s.status === "error" ? "bg-destructive text-white" : "bg-muted text-muted-foreground"
              }`}
            >
              {s.status === "done" ? <IconCheck className="size-4" stroke={3} aria-hidden /> : s.status === "error" ? "!" : i + 1}
            </span>
            <div className="pt-1">
              <p className={`font-bold ${s.status === "todo" ? "text-muted-foreground" : ""}`}>
                {s.label}
                {s.status === "current" ? <span className="ml-2 inline-flex size-2 animate-pulse rounded-full bg-brand align-middle" aria-hidden /> : null}
              </p>
              <p className="text-[13px] text-muted-foreground">{s.sub}</p>
            </div>
          </li>
        ))}
      </ol>

      {state === "rejected" ? (
        <div role="alert" className="flex gap-3 rounded-lg border border-destructive/30 bg-destructive-subtle p-4 text-destructive-on-subtle">
          <IconAlertTriangleFilled className="mt-0.5 size-5 shrink-0" aria-hidden />
          <div>
            <p className="font-bold">退回理由</p>
            <p className="mt-1 text-sm leading-relaxed">{rejectReason(profile)}</p>
          </div>
        </div>
      ) : null}

      {state === "approved" ? (
        <form method="post" action="/api/proto-role">
          <input type="hidden" name="role" value="student" />
          <input type="hidden" name="returnTo" value="/dashboard/student" />
          <button type="submit" className="btn-fju h-12 w-full text-base">進入系統</button>
        </form>
      ) : (
        <div className="rounded-lg bg-secondary p-4.5 text-secondary-foreground">
          <p className="flex items-center gap-2 font-bold text-foreground"><IconId className="size-5 text-brand" aria-hidden />請帶學生證到系辦核對身分</p>
          <dl className="mt-3 grid grid-cols-[4.75rem_1fr] gap-x-2 gap-y-2 text-sm">
            <dt className="text-muted-foreground">地點</dt>
            <dd className="font-semibold text-foreground">
              <span className="inline-flex items-center gap-1"><IconMapPin className="size-4 text-brand" aria-hidden />利瑪竇大樓 LM306（資管系辦公室）</span>
              <span className="mt-0.5 block text-xs font-normal text-muted-foreground">新北市新莊區中正路 510 號</span>
            </dd>
            <dt className="text-muted-foreground">要帶</dt>
            <dd className="text-foreground">學生證（或其他附照片的身分證件）</dd>
            <dt className="text-muted-foreground">多久開通</dt>
            <dd className="text-foreground">核對後通常 1～3 個工作天開通，結果會寄到你的 Email。</dd>
          </dl>
        </div>
      )}

      <section aria-labelledby="profile-h" className="rounded-lg border border-border">
        {editing ? (
          <form noValidate onSubmit={save} className="flex flex-col gap-4 p-4.5">
            <h2 id="profile-h" ref={formHeadingRef} tabIndex={-1} className="font-bold outline-none">修改資料</h2>
            <TextField id="name" label="姓名" defaultValue={profile.name} error={errors.name} autoComplete="name" required />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField id="studentNo" label="學號" defaultValue={profile.studentNo} inputMode="numeric" maxLength={9} error={errors.studentNo} required />
              <TextField id="className" label="系級" defaultValue={profile.className} error={errors.className} required />
            </div>
            <TextField id="phone" label="手機" type="tel" defaultValue={profile.phone} error={errors.phone} autoComplete="tel" required />
            <TextField id="emailRo" label="Email" value={profile.email} readOnly hint="Email 是登入帳號，不能在這裡修改" />
            <div className="flex gap-3">
              <button type="submit" className="btn-fju h-11 flex-1 text-[15px]">{state === "rejected" ? "儲存並重新送出" : "儲存"}</button>
              <button type="button" onClick={() => { setErrors({}); setEditing(false); }} className="h-11 flex-1 rounded-[4px] border border-input font-semibold transition-colors hover:bg-accent">取消</button>
            </div>
          </form>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3 border-b border-border px-4.5 py-3">
              <div>
                <h2 id="profile-h" className="font-bold">送出的資料</h2>
                {editedAt ? <p className="text-xs text-muted-foreground">已編輯・{editedAt}</p> : null}
              </div>
              {state !== "approved" ? (
                <button ref={editBtnRef} type="button" onClick={() => setEditing(true)} className="inline-flex h-9 items-center gap-1.5 rounded-md border border-input px-3 text-sm font-semibold transition-colors hover:bg-accent">
                  <IconPencil className="size-4" aria-hidden />修改資料
                </button>
              ) : null}
            </div>
            <dl className="flex flex-col gap-2.5 px-4.5 py-4 text-sm">
              {([["姓名", profile.name], ["學號", profile.studentNo], ["系級", profile.className], ["手機", profile.phone], ["Email", profile.email]] as const).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4">
                  <dt className="shrink-0 text-muted-foreground">{k}</dt>
                  <dd className="min-w-0 text-right font-semibold break-all">{v}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </section>

      <p className="text-[13px] leading-relaxed text-muted-foreground">
        有問題可以打系辦電話 <a href="tel:+886229052666" className="font-semibold text-foreground underline underline-offset-2">02-2905-2666</a>。
        <Link href="/" className="ml-1 font-semibold text-brand hover:underline">回到首頁</Link>
      </p>

      <DemoBox>
        切換審核結果：
        <span className="mt-1.5 flex flex-wrap gap-1.5">
          {(["pending", "rejected", "approved"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => { setEditing(false); setState(s); }}
              aria-pressed={state === s}
              className={`rounded-md border px-2.5 py-1 text-xs font-bold ${state === s ? "border-warning bg-warning text-warning-foreground" : "border-warning/50 bg-background hover:bg-warning-subtle"}`}
            >
              {s === "pending" ? "審核中" : s === "rejected" ? "被退回" : "已開通"}
            </button>
          ))}
        </span>
      </DemoBox>
    </div>
  );
}
