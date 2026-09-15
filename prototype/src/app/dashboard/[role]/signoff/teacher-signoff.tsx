"use client";

import { useState } from "react";
import { IconSignature } from "@tabler/icons-react";
import { EmptyState, PageTitle, Panel, Pill } from "@/components/dashboard/primitives";
import { ApproveActions } from "@/components/dashboard/signoff-actions";
import { CURRENT_USERS, SIGNOFF, SIGNOFF_PROGRESS, TODAY_YMD, teacherGroups, teacherSignReady, teacherSignWaiting } from "@/lib/fixtures";

type Done = "approved" | "declined";

/* 老師：輪到我的組直接呈現版本與本人動作；等待學生的組列出誰還沒（T-06） */
export function TeacherSignoff() {
  const me = CURRENT_USERS.teacher;
  const mine = new Set(teacherGroups().map((g) => g.id));
  const ready = teacherSignReady();
  const waiting = teacherSignWaiting();
  const complete = SIGNOFF_PROGRESS.filter((p) => mine.has(p.groupId) && p.state === "complete");
  const [done, setDone] = useState<Record<string, Done>>({});
  const readyLeft = ready.filter((p) => !done[p.groupId]).length;
  const completeCount = complete.length + Object.values(done).filter((d) => d === "approved").length;
  const rows = [...ready, ...waiting, ...complete];

  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="同意書簽核" description={`${SIGNOFF.title}・v${SIGNOFF.packageVersion}。五位學生全數同意後，才輪到指導老師。`} />
      <p className="tabular text-sm">
        <b className={readyLeft ? "text-brand" : ""}>待我同意 {readyLeft} 組</b>
        <span className="text-muted-foreground">・等待學生 {waiting.length} 組・完成 {completeCount} 組</span>
      </p>
      <Panel title="我的指導組別" icon={<IconSignature />} description={`${rows.length} 組`}>
        {rows.length === 0 ? <EmptyState title="沒有指導組別" /> : (
          <ul className="divide-y divide-border">
            {rows.map((p) => {
              const d = done[p.groupId];
              const state = d === "approved" ? "complete" : d === "declined" ? "revision" : p.state;
              return (
                <li key={p.groupId} className={`grid items-center gap-x-4 gap-y-3 px-5 py-4 md:grid-cols-[minmax(0,1fr)_auto] ${state === "teacher" ? "border-l-[3px] border-l-brand" : ""}`}>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="tabular text-xs font-semibold text-muted-foreground">{p.groupNo}</span>
                      {state === "complete" ? <Pill tone="success">完成</Pill> : state === "revision" ? <Pill tone="brand">退回修正</Pill> : state === "teacher" ? <Pill tone="brand">輪到你</Pill> : <Pill tone="default">等待學生</Pill>}
                    </div>
                    <p className="truncate text-[15px] font-semibold">{p.title.replace(/（產學：.*）/, "")}</p>
                    <p className="tabular mt-0.5 text-xs text-muted-foreground">
                      {state === "students" ? `學生 ${p.students}/${p.total} 已同意・還沒：${p.missing.join("、")}` : state === "teacher" ? `學生 ${p.students}/${p.total} 已同意・v${SIGNOFF.packageVersion}・等你` : state === "revision" ? "已退回，修正後全組重走一次" : `學生 ${p.total}/${p.total}・老師已同意・v${SIGNOFF.packageVersion}`}
                    </p>
                  </div>
                  <div className="md:justify-self-end">
                    {state === "teacher" ? <ApproveActions who={`${me.name} 老師`} title={SIGNOFF.title} packageVersion={SIGNOFF.packageVersion} onDone={(r) => setDone((m) => ({ ...m, [p.groupId]: r }))} /> : d ? <span className="tabular text-xs text-muted-foreground">{TODAY_YMD}</span> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
