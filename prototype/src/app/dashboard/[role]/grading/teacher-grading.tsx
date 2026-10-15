"use client";

import Link from "next/link";
import { useState } from "react";
import { IconClock, IconFilter } from "@tabler/icons-react";
import { useGradeRecords } from "@/lib/grading-store";
import { GRADE_STATE_LABEL, GRADING_GROUPS, RUBRIC, TEACHER_BASE as base, gradingCounts, scoreSummary, type GradeState } from "@/lib/teacher-v2";

/**
 * 老師：評分總覽 v2（Roy 2026-10-15，Q78；照 grading-mock/grading-overview.png，不放插圖與標語）。
 * 「已評 3／5 組」＋篩選 全部／待評／草稿／已送出＋每組一張卡。
 */
type Filter = "all" | GradeState;
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "pending", label: "待評" },
  { key: "draft", label: "草稿" },
  { key: "submitted", label: "已送出" },
];

export const STATE_CHIP: Record<GradeState, string> = {
  pending: "bg-muted text-muted-foreground",
  draft: "bg-brand-subtle text-brand-on-subtle",
  submitted: "bg-success-subtle text-success-on-subtle",
};
const SEGMENT: Record<GradeState, string> = { pending: "bg-border", draft: "bg-brand", submitted: "bg-success" };

export function TeacherGrading() {
  const records = useGradeRecords();
  const [filter, setFilter] = useState<Filter>("all");
  const counts = gradingCounts(records);
  const rows = GRADING_GROUPS.map((g, i) => ({ g, i, rec: records[g.groupId] ?? g.seed }));
  const list = rows.filter((r) => filter === "all" || r.rec.state === filter);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="page-title">評分</h1>

      <section aria-label="評分進度" className="dash-card flex flex-col gap-4 p-6 md:flex-row md:items-center md:gap-8" data-progress>
        <p className="shrink-0 text-[28px] leading-none font-extrabold tracking-tight">
          已評 <span className="tabular text-brand">{counts.submitted}</span>
          <span className="tabular text-muted-foreground">／{counts.total}</span> 組
        </p>
        <ol className="flex flex-1 gap-1.5" aria-label="各組狀態">
          {rows.map(({ g, rec }) => (
            <li key={g.groupId} className="flex-1">
              <span className={`block h-3 rounded-full ${SEGMENT[rec.state]}`} title={`${g.no} ${GRADE_STATE_LABEL[rec.state]}`} />
              <span className="tabular mt-1.5 block text-center text-[11px] font-semibold text-muted-foreground">{g.no.replace("第 ", "G").replace(" 組", "")}</span>
            </li>
          ))}
        </ol>
      </section>

      <nav aria-label="篩選" className="flex flex-wrap items-center gap-2" data-filter>
        <IconFilter className="size-4 text-muted-foreground" aria-hidden />
        {FILTERS.map((f) => {
          const n = f.key === "all" ? rows.length : rows.filter((r) => r.rec.state === f.key).length;
          const on = f.key === filter;
          return (
            <button key={f.key} type="button" onClick={() => setFilter(f.key)} aria-pressed={on} className={`inline-flex h-10 items-center gap-1.5 rounded-full px-4 text-sm font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring/40 ${on ? "bg-brand text-brand-foreground" : "bg-card text-muted-foreground ring-1 ring-border hover:text-foreground"}`}>
              {f.label}
              <span className={`tabular text-xs ${on ? "opacity-85" : ""}`}>{n}</span>
            </button>
          );
        })}
      </nav>

      {list.length === 0 ? (
        <p className="rounded-3xl border border-dashed border-border bg-card/60 px-6 py-14 text-center text-[15px] font-bold">沒有{FILTERS.find((f) => f.key === filter)?.label}的組</p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" data-cards>
          {list.map(({ g, rec }) => {
            const sum = scoreSummary(rec.scores);
            const filled = RUBRIC.length - sum.missing;
            return (
              <li key={g.groupId}>
                <article className="dash-card dash-card-hover flex h-full flex-col p-5" data-group-card={g.groupId}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="tabular text-[12px] font-bold text-muted-foreground">{g.no}</p>
                      <h2 className="mt-0.5 text-[17px] leading-snug font-extrabold">{g.title}</h2>
                    </div>
                    <span className={`shrink-0 rounded-full px-2.5 py-1 text-[12px] font-bold ${STATE_CHIP[rec.state]}`}>{GRADE_STATE_LABEL[rec.state]}{rec.unsent ? "・有修改" : ""}</span>
                  </div>
                  <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{g.blurb}</p>
                  <div className="mt-4 flex items-center gap-1" aria-label={`已填 ${filled}／${RUBRIC.length} 項`}>
                    {RUBRIC.map((c) => <span key={c.id} className={`h-1.5 flex-1 rounded-full ${rec.scores[c.id]?.value ? (rec.state === "submitted" ? "bg-success" : "bg-brand") : "bg-muted"}`} />)}
                  </div>
                  <div className="mt-auto flex items-end justify-between gap-3 pt-5">
                    <span className="tabular text-[13px] text-muted-foreground">
                      {rec.state === "pending" ? "還沒開始" : <><span className="text-[22px] leading-none font-extrabold text-foreground">{sum.total}</span> 分</>}
                      {rec.lastEdited ? <span className="mt-1 flex items-center gap-1"><IconClock className="size-3.5" />{rec.lastEdited}</span> : null}
                    </span>
                    <Link href={`${base}/grading/${g.groupId}`} className={`inline-flex h-10 shrink-0 items-center rounded-full px-4 text-sm font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring/40 ${rec.state === "submitted" ? "text-brand-on-subtle ring-1 ring-brand/50 hover:bg-brand-subtle" : "bg-brand text-brand-foreground hover:bg-brand/90"}`}>
                      {rec.state === "submitted" ? "查看或修改" : "繼續評分"}
                    </Link>
                  </div>
                </article>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
