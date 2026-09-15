"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { IconChevronDown, IconX } from "@tabler/icons-react";
import { ResetDialog } from "@/components/dashboard/reset-dialog";
import { GROUPS, SIGNOFF, SIGNOFF_PROGRESS, TEACHERS, type SignoffState } from "@/lib/fixtures";

const STATE_LABEL: Record<SignoffState, string> = { complete: "完成", teacher: "學生已齊、等老師", students: "學生未齊", revision: "需重簽" };

/**
 * 各組簽核進度（Codex 09-10 A-06）：格數＝p.total（第 09 組 4 人就 4 格）＋老師 1 格；
 * 「缺 N 位」可展開姓名與個別狀態；?state=teacher 只列等老師的組並顯示可移除的篩選標籤。
 */
export function SignoffGroups({ base }: { base: string }) {
  const sp = useSearchParams();
  const state = sp.get("state");
  const filter = state === "teacher" || state === "students" || state === "complete" ? state : null;
  const rows = filter ? SIGNOFF_PROGRESS.filter((p) => p.state === filter) : SIGNOFF_PROGRESS;
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="flex flex-col">
      {filter ? (
        <div className="px-5 pt-3">
          <span className="inline-flex h-9 items-center gap-2 rounded-full border border-brand bg-brand-subtle pl-3.5 pr-1.5 text-sm font-semibold text-brand-on-subtle">
            篩選：{STATE_LABEL[filter]} <span className="tabular">{rows.length}／{SIGNOFF_PROGRESS.length} 組</span>
            <Link href={base} scroll={false} className="inline-flex size-6 items-center justify-center rounded-full transition-colors hover:bg-brand hover:text-brand-foreground" aria-label="移除篩選"><IconX className="size-3.5" /></Link>
          </span>
        </div>
      ) : null}
      <ul className="flex flex-col px-5 py-2">
        {rows.map((p) => {
          const g = GROUPS.find((x) => x.id === p.groupId)!;
          const advisor = TEACHERS.find((t) => t.id === g.advisorId) ?? null;
          const signed = g.members.slice(0, p.students).map((m) => m.name);
          const open = openId === p.groupId;
          const missingCount = p.total - p.students;
          const label = p.state === "complete" ? "完成" : p.state === "teacher" ? (advisor ? `等 ${advisor.name}` : "等老師（未指派）") : `缺 ${missingCount} 位`;
          const expandable = p.state !== "complete";
          return (
            <li key={p.groupId} className="border-b border-border/70 last:border-0">
              <div className="grid items-center gap-x-3 gap-y-1.5 py-3 md:grid-cols-[4.5rem_minmax(0,1fr)_9rem_auto]">
                <span className="tabular text-sm font-bold">{p.groupNo}</span>
                <div className="flex gap-0.5" role="img" aria-label={`學生 ${p.students}／${p.total}，老師${p.teacher ? "已" : "未"}簽`}>
                  {Array.from({ length: p.total }, (_, k) => <span key={k} className={`h-3 flex-1 rounded-sm ${k < p.students ? "bg-primary" : "bg-muted"}`} />)}
                  <span className={`ml-1.5 h-3 w-8 shrink-0 rounded-sm ${p.teacher ? "bg-success" : "bg-muted"}`} />
                </div>
                {expandable ? (
                  <button type="button" onClick={() => setOpenId(open ? null : p.groupId)} aria-expanded={open} className={`inline-flex h-8 items-center gap-1 justify-self-start rounded-lg px-2 text-sm font-semibold transition-colors hover:bg-accent ${p.state === "teacher" ? "text-brand" : "text-foreground"}`}>
                    {label}<IconChevronDown className={`size-4 transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
                  </button>
                ) : <span className="text-sm font-semibold text-success-on-subtle">{label}</span>}
                <div className="md:justify-self-end"><ResetDialog groupNo={p.groupNo} version={SIGNOFF.packageVersion} signed={signed} teacher={advisor ? { name: advisor.name, signed: p.teacher } : null} /></div>
              </div>
              {open ? (
                <ul className="mb-3 flex flex-wrap gap-1.5 rounded-lg bg-muted/40 px-3 py-2.5 text-sm">
                  {g.members.map((m, k) => (
                    <li key={m.id} className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 ${k < p.students ? "border-success/30 bg-success-subtle text-success-on-subtle" : "border-destructive/35 bg-destructive-subtle text-destructive-on-subtle"}`}><span className="font-semibold">{m.name}</span><span className="text-xs">{k < p.students ? "已同意" : "未同意"}</span></li>
                  ))}
                  <li className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 ${p.teacher ? "border-success/30 bg-success-subtle text-success-on-subtle" : p.state === "teacher" ? "border-brand/30 bg-brand-subtle text-brand-on-subtle" : "border-border bg-background text-muted-foreground"}`}><span className="font-semibold">老師・{advisor?.name ?? "尚未指派"}</span><span className="text-xs">{p.teacher ? "已同意" : p.state === "teacher" ? "輪到老師" : "等學生齊"}</span></li>
                </ul>
              ) : null}
            </li>
          );
        })}
        {rows.length === 0 ? <li className="py-8 text-center text-sm text-muted-foreground">這個狀態沒有組別。</li> : null}
      </ul>
    </div>
  );
}
