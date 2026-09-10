"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { IconAlertTriangle, IconBuilding, IconCheck, IconCrown } from "@tabler/icons-react";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { buttonVariants } from "@/components/ui/button";
import { Pill, StateBadge } from "@/components/dashboard/primitives";
import { AssignDialog } from "@/components/dashboard/group-actions";
import { INPUT, Stamp, TEXTAREA, fakeTime } from "@/components/dashboard/stamp";
import { GROUP_SUBMISSIONS, INDUSTRY, MANAGED_ITEMS, SIGNOFF_PROGRESS, TEACHERS, type Group } from "@/lib/fixtures";

type ExceptionKind = "dissolve" | "regroup" | "resize";
const EXCEPTION: Record<ExceptionKind, { label: string; title: (g: Group) => string; impacts: (g: Group) => string[]; placeholder: string }> = {
  dissolve: { label: "解散", title: (g) => `解散 ${g.no}`, impacts: (g) => [`${g.members.length} 位組員回到「未分組」，需重新找組`, "已繳交的整組表單保留在歷程，但不再計入本組", g.advisorId ? "指導老師的指派會取消，並收到通知" : "尚未指派老師，不影響老師", "同意書簽署全部失效"], placeholder: "例：兩位組員休學，其餘併入其他組" },
  regroup: { label: "重組", title: (g) => `重組 ${g.no}`, impacts: (g) => ["可移出或加入組員；每次異動都留紀錄", `${g.members.filter((m) => m.confirmed).length} 位已確認的成員要重新確認名單`, "整組表單的草稿保留，正式送出的版本不動", "同意書需重新簽署"], placeholder: "例：與第 09 組互換一位組員" },
  resize: { label: "調整人數", title: (g) => `調整 ${g.no} 人數`, impacts: (g) => [`目前 ${g.members.length} 人；規則 §4 以五人為原則，非五人會標成例外組`, "例外組需系辦記錄理由，老師在分組總覽看得到", "不影響已繳交的表單"], placeholder: "例：轉系生名額不足，核准 4 人成組" },
};

function ExceptionDialog({ group, kind }: { group: Group; kind: ExceptionKind }) {
  const spec = EXCEPTION[kind];
  const [reason, setReason] = useState("");
  const [size, setSize] = useState(group.members.length);
  const [done, setDone] = useState(false);
  return (
    <Dialog onOpenChange={(o) => { if (!o) { setDone(false); setReason(""); } }}>
      <DialogTrigger render={<button type="button" className={buttonVariants({ size: "sm", variant: kind === "dissolve" ? "destructive" : "outline", className: "press rounded-lg" })} />}>{spec.label}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        {done ? (
          <Stamp label="已記錄" title={spec.title(group)} description={<>{fakeTime()}・理由與影響已寫入操作紀錄；相關人員會收到通知。原型不改資料。</>} />
        ) : (
          <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); setDone(true); }}>
            <div><DialogTitle className="text-lg font-extrabold">{spec.title(group)}</DialogTitle><DialogDescription className="mt-1">先看影響，再寫理由。這是例外處理，會留在操作紀錄。</DialogDescription></div>
            <ul className="flex flex-col gap-1.5 rounded-lg border border-border px-4 py-3 text-sm">{spec.impacts(group).map((t) => <li key={t} className="flex gap-2"><IconAlertTriangle className="mt-0.5 size-4 shrink-0 text-brand" />{t}</li>)}</ul>
            {kind === "resize" ? <label htmlFor={`rz-${group.id}`} className="flex flex-col gap-1.5 text-sm font-semibold">核准人數<input id={`rz-${group.id}`} type="number" min={1} max={6} value={size} onChange={(e) => setSize(Number(e.target.value))} className={`${INPUT} tabular w-24`} /></label> : null}
            <label htmlFor={`ex-${kind}-${group.id}`} className="flex flex-col gap-1.5 text-sm font-semibold">理由（必填）<textarea id={`ex-${kind}-${group.id}`} required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={spec.placeholder} className={TEXTAREA} /></label>
            <button type="submit" className={kind === "dissolve" ? buttonVariants({ variant: "destructive", size: "lg", className: "press h-11 rounded-lg" }) : "btn-fju h-11 text-sm"}>確認{spec.label}</button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * 組別詳情（Codex 09-10 A-04）：成員（含確認狀態）、指導老師（重派＝AssignDialog）、產學連結、繳交狀態摘要、例外處理。
 * 從分組表格點組別開啟。
 */
export function GroupDetailSheet({ group, trigger, base = "/dashboard/admin" }: { group: Group; trigger: ReactNode; base?: string }) {
  const advisor = TEACHERS.find((t) => t.id === group.advisorId) ?? null;
  const industry = group.industryId ? INDUSTRY.find((i) => i.id === group.industryId) : null;
  const confirmed = group.members.filter((m) => m.confirmed).length;
  const sign = SIGNOFF_PROGRESS.find((p) => p.groupId === group.id);
  const intake = MANAGED_ITEMS.filter((i) => i.progress).map((i) => ({ item: i, sub: GROUP_SUBMISSIONS[i.id]?.find((s) => s.groupId === group.id) }));
  return (
    <Sheet>
      <SheetTrigger nativeButton={false} render={<span className="contents" />}>{trigger}</SheetTrigger>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg data-[side=right]:sm:max-w-lg">
        <div className="px-5 pt-5 pr-14">
          <div className="flex flex-wrap items-center gap-2">
            <span className="tabular text-xs font-bold tracking-[0.06em] text-muted-foreground">{group.no}</span>
            {group.type === "INDUSTRY" ? <Pill tone="brand">產學合作</Pill> : <Pill tone="default">一般專題</Pill>}
            {group.status === "forming" ? <Pill tone="brand">成立中 {confirmed}/{group.members.length}</Pill> : group.status === "exception" ? <Pill tone="warning">例外組・{group.members.length} 人</Pill> : <Pill tone="success">已成立</Pill>}
          </div>
          <SheetTitle className="mt-1 text-[18px] font-extrabold leading-snug">{group.title.replace(/（產學：.*）/, "")}</SheetTitle>
          <SheetDescription className="mt-0.5">成員、老師、產學連結與繳交都在這裡；例外處理在最下面。</SheetDescription>
        </div>

        <section className="border-t border-border px-5 py-4">
          <h3 className="text-[13px] font-bold tracking-[0.04em] text-muted-foreground">成員 <span className="tabular">{confirmed}／{group.members.length} 已確認</span></h3>
          <ul className="mt-2 flex flex-col gap-1.5">
            {group.members.map((m) => (
              <li key={m.id} className="flex items-center gap-2.5 text-sm">
                <span className={`inline-flex size-5 shrink-0 items-center justify-center rounded-full ${m.confirmed ? "bg-success text-success-foreground" : "border-2 border-border"}`}>{m.confirmed ? <IconCheck className="size-3" strokeWidth={3} /> : null}</span>
                <span className="font-semibold">{m.name}</span>
                {m.isLeader ? <IconCrown className="size-3.5 text-brand" aria-label="組長" /> : null}
                <span className="tabular text-xs text-muted-foreground">{m.studentNo}</span>
                <span className={`ml-auto text-xs font-semibold ${m.confirmed ? "text-success-on-subtle" : "text-destructive"}`}>{m.confirmed ? "已確認" : "未確認"}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="border-t border-border px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-[13px] font-bold tracking-[0.04em] text-muted-foreground">指導老師</h3>
              <p className="mt-1 text-sm font-semibold">{advisor ? <>{advisor.name} <span className="text-xs font-normal text-muted-foreground">{advisor.email}</span></> : <span className="text-destructive">尚未指派</span>}</p>
            </div>
            <AssignDialog groupNo={group.no} current={advisor?.name} />
          </div>
          {industry ? (
            <Link href={`${base}/industry`} className="mt-3 flex items-center gap-2.5 rounded-lg border border-border px-3 py-2.5 text-sm transition-colors hover:border-brand">
              <IconBuilding className="size-4 shrink-0 text-brand" />
              <span className="min-w-0 flex-1"><span className="block truncate font-semibold">{industry.company}</span><span className="block truncate text-xs text-muted-foreground">{industry.title}・{industry.status === "claimed" ? "已認領" : "待認領"}</span></span>
            </Link>
          ) : null}
        </section>

        <section className="border-t border-border px-5 py-4">
          <h3 className="text-[13px] font-bold tracking-[0.04em] text-muted-foreground">繳交狀態</h3>
          <ul className="mt-2 flex flex-col gap-1.5">
            {intake.map(({ item, sub }) => (
              <li key={item.id} className="flex items-center gap-2 text-sm">
                <Link href={`${base}/affairs/${item.id}?group=${group.id}`} className="min-w-0 flex-1 truncate font-semibold hover:text-brand">{item.title}</Link>
                {sub?.version ? <span className="tabular text-xs text-muted-foreground">v{sub.version}</span> : null}
                {sub ? <StateBadge state={sub.state} /> : <span className="text-xs text-muted-foreground">—</span>}
              </li>
            ))}
            {sign ? <li className="flex items-center gap-2 border-t border-border/70 pt-1.5 text-sm"><span className="min-w-0 flex-1 truncate font-semibold">成果授權同意書</span><span className="tabular text-xs text-muted-foreground">學生 {sign.students}／{sign.total}・老師{sign.teacher ? "已簽" : "未簽"}</span></li> : null}
          </ul>
        </section>

        <section className="border-t border-border px-5 py-4">
          <h3 className="text-[13px] font-bold tracking-[0.04em] text-muted-foreground">例外處理 <span className="font-normal">・各要理由，先列影響</span></h3>
          <div className="mt-2 flex flex-wrap gap-2">
            <ExceptionDialog group={group} kind="regroup" />
            <ExceptionDialog group={group} kind="resize" />
            <ExceptionDialog group={group} kind="dissolve" />
          </div>
        </section>
      </SheetContent>
    </Sheet>
  );
}
