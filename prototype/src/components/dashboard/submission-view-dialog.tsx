"use client";

import type { ReactNode } from "react";
import { IconPaperclip } from "@tabler/icons-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { buttonVariants } from "@/components/ui/button";
import { StateBadge } from "@/components/dashboard/primitives";
import { SUBMISSION_VERSIONS, type FormField, type Group, type GroupSubmission, type ManagedItem } from "@/lib/fixtures";

/**
 * 已繳內容檢視（Codex 09-10 A-04）：該版本欄位值、附件、提交者、時間、版本歷程。
 * 管理員在同一個 dialog 有「重新開放」入口（由父層傳進來）。
 * 原型：欄位值是依欄位型別造的假快照；正式版讀該版本的 answers。
 */
const SNAPSHOT: Record<FormField["type"], (f: FormField, g: Group) => string> = {
  text: (f, g) => (f.label.includes("學號") ? g.members[0].studentNo : f.label.includes("題目") ? g.title.replace(/（產學：.*）/, "") : `${g.title.slice(0, 6)}…`),
  textarea: (_, g) => `${g.title.replace(/（產學：.*）/, "")}：以 Next.js 與 PostgreSQL 實作，預計三個月完成第一版。`,
  number: () => "5",
  email: (_, g) => `${g.members[0].studentNo}@m365.fju.edu.tw`,
  url: (_, g) => `https://demo.fju.dev/${g.id}`,
  radio: (f, g) => f.options?.[g.type === "INDUSTRY" ? 1 : 0] ?? "",
  checkbox: (f) => (f.options ?? []).join("、"),
  select: (f, g) => f.options?.[g.members.length % (f.options.length || 1)] ?? "",
  date: () => "2026-08-14",
  time: () => "14:00",
  file: (f, g) => `${g.no.replace(/\s/g, "")}_${f.label}.pdf`,
  attachment: () => "",
  heading: () => "",
  paragraph: () => "",
  divider: () => "",
  groupinfo: (_, g) => `${g.no}・${g.members.map((m) => m.name).join("、")}`,
};

export function SubmissionViewDialog({ item, group, row, fields, children, trigger }: { item: ManagedItem; group: Group; row: GroupSubmission; fields: FormField[]; children?: ReactNode; trigger?: React.ReactElement }) {
  const version = row.version ?? 1;
  const history: { version: number; by: string; at: string; schemaVersion: number; note?: string }[] = group.id === "g-07" && SUBMISSION_VERSIONS[item.id]
    ? SUBMISSION_VERSIONS[item.id]
    : Array.from({ length: version }, (_, k) => ({ version: version - k, by: k === 0 ? row.submittedBy ?? "" : group.members[(k + 1) % group.members.length].name, at: k === 0 ? row.at ?? "" : `2026-08-${String(8 + k).padStart(2, "0")} 20:1${k}`, schemaVersion: item.schemaVersion ?? 1 }));
  const files = fields.filter((f) => f.type === "file").map((f) => ({ label: f.label, name: SNAPSHOT.file(f, group), size: `${(2 + group.members.length * 1.3).toFixed(1)} MB` }));
  return (
    <Dialog>
      <DialogTrigger render={trigger ?? <button type="button" className={buttonVariants({ size: "sm", variant: "outline", className: "press rounded-lg" })} />}>
        <IconPaperclip /> 檢視
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto p-0 sm:max-w-2xl">
        <div className="border-b border-border px-6 py-4 pr-12">
          <p className="text-xs font-semibold text-muted-foreground">{item.title}</p>
          <DialogTitle className="mt-0.5 text-lg font-extrabold">{group.no}・v{version}</DialogTitle>
          <DialogDescription className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <StateBadge state={row.state} />
            <span>{row.submittedBy} 送出（代表全組）</span>
            <span className="tabular">{row.at}</span>
            <span>欄位版本 v{item.schemaVersion ?? 1}</span>
          </DialogDescription>
        </div>
        <dl className="divide-y divide-border px-6">
          {fields.filter((f) => !["heading", "paragraph", "divider", "attachment"].includes(f.type)).map((f) => (
            <div key={f.id} className="grid gap-1 py-3 sm:grid-cols-[11rem_1fr] sm:gap-4">
              <dt className="text-sm text-muted-foreground">{f.label}</dt>
              <dd className="text-sm font-semibold break-words">{f.type === "file" ? <span className="inline-flex items-center gap-1.5"><IconPaperclip className="size-4 text-muted-foreground" />{SNAPSHOT.file(f, group)}</span> : SNAPSHOT[f.type](f, group) || <span className="font-normal text-muted-foreground">（未填）</span>}</dd>
            </div>
          ))}
        </dl>
        {files.length ? (
          <div className="border-t border-border px-6 py-3">
            <p className="text-xs font-bold text-muted-foreground">附件 {files.length} 個</p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {files.map((f) => <li key={f.name} className="flex items-center justify-between gap-3 text-sm"><span className="inline-flex min-w-0 items-center gap-1.5"><IconPaperclip className="size-4 shrink-0 text-muted-foreground" /><span className="truncate font-semibold">{f.name}</span></span><span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground"><span className="tabular">{f.size}</span><button type="button" disabled title="尚未提供" className="rounded-md px-2 py-1 font-semibold text-muted-foreground disabled:opacity-50">下載</button><span>尚未提供</span></span></li>)}
            </ul>
          </div>
        ) : null}
        <div className="border-t border-border px-6 py-3">
          <p className="text-xs font-bold text-muted-foreground">版本歷程</p>
          <ol className="mt-2 flex flex-col gap-1.5">
            {history.map((h) => (
              <li key={h.version} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm">
                <span className={`tabular font-semibold ${h.version === version ? "" : "text-muted-foreground"}`}>v{h.version}</span>
                <span>{h.by}</span>
                <span className="tabular text-muted-foreground">{h.at}</span>
                {h.version === version ? <span className="rounded bg-success-subtle px-1.5 py-0.5 text-[11px] font-semibold text-success-on-subtle">採計</span> : null}
                {h.note ? <span className="text-xs text-muted-foreground">{h.note}</span> : null}
              </li>
            ))}
          </ol>
        </div>
        {children ? <div className="flex items-center justify-between gap-3 border-t border-border bg-muted/40 px-6 py-3 text-xs text-muted-foreground">要讓這組在截止後重送，先重新開放。<span>{children}</span></div> : null}
      </DialogContent>
    </Dialog>
  );
}
