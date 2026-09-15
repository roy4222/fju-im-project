"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { IconArrowRight, IconCheck, IconFocus2, IconPencil, IconPlus } from "@tabler/icons-react";
import { StageEditDialog } from "@/components/dashboard/stage-edit-dialog";
import { TODAY_YMD, daysUntil, stageTasksFor, type Role, type Stage } from "@/lib/fixtures";

/**
 * 專題時間軸 B「直立蛇形」（Roy 2026-09-10 從畫布挑的），Codex 09-10 S-04 修正版：
 * - 上方一條摘要：目前階段｜日期｜一顆主要按鈕；「時間已過 N%」講清楚是時間流逝，不是個人完成度。
 * - 卡片貼近中線；過去／未來只顯示名稱、日期、狀態一行，點開才看說明；只有目前階段預設展開、有唯一主要按鈕。
 * - 沒有循環動畫、沒有發光、沒有傾斜。目前階段用手冊書籤：卡片左上一小塊橘色頁籤寫「現在」，細線脊椎。
 * - 手機（<768px）單側直線，標記在左。
 * - 管理員：新增／編輯用 StageEditDialog（另一位 agent 實作內容）。
 */
const YEAR = TODAY_YMD.slice(0, 4);
function md(d: string) { return d.slice(5).replace("-", "/"); }
function ymd(d: string) { return d.replaceAll("-", "/"); }
/** 同一個西元年只寫月日；跨年或不在今年就寫完整年月日 */
function range(from: string, to: string) {
  const fy = from.slice(0, 4), ty = to.slice(0, 4);
  return fy === YEAR && ty === YEAR ? `${md(from)} – ${md(to)}` : `${ymd(from)} – ${ymd(to)}`;
}

const PRIMARY_LABEL: Record<string, string> = { "/dashboard/student/groups": "前往確認組員", "/dashboard/teacher/groups": "前往認領組別", "/dashboard/admin/groups": "處理未分組名單" };
const STATUS_WORD = { done: "已完成", current: "進行中", upcoming: "尚未開始" } as const;

export function TimelineZigzag({ stages, role, canEdit = false }: { stages: Stage[]; role: Role; canEdit?: boolean }) {
  const cur = stages.find((s) => s.status === "current") ?? stages[0];
  const [openId, setOpenId] = useState(cur.id);
  const curRef = useRef<HTMLLIElement>(null);
  const doneCount = stages.filter((s) => s.status === "done").length;
  const spinePct = ((doneCount + 0.5) / stages.length) * 100;
  const total = Math.max(1, daysUntil(cur.to) - daysUntil(cur.from));
  const elapsed = Math.min(100, Math.max(0, Math.round((-daysUntil(cur.from) / total) * 100)));
  const primary = stageTasksFor(cur, role).find((t) => !t.done);

  return (
    <div className="tl-wrap dash-card relative overflow-hidden">
      {/* 摘要一條：目前階段｜日期｜主要按鈕 */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b border-border px-5 py-4 sm:px-6">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold tracking-[0.06em] text-brand">目前</p>
          <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span className="text-[20px] font-extrabold tracking-tight">{cur.title}</span>
            <span className="tabular text-sm text-muted-foreground">{range(cur.from, cur.to)}</span>
            <span className="tabular text-sm text-muted-foreground">時間已過 {elapsed}%・剩 {daysUntil(cur.to)} 天</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => curRef.current?.scrollIntoView({ block: "center", behavior: "smooth" })} className="inline-flex h-11 items-center gap-1.5 rounded-lg border border-border px-3.5 text-sm font-semibold transition-colors hover:bg-accent"><IconFocus2 className="size-4" /> 回到目前階段</button>
          {primary ? <Link href={primary.href} className="btn-fju h-11 rounded-lg px-5 text-sm">{PRIMARY_LABEL[primary.href] ?? primary.label}<IconArrowRight className="size-4" /></Link> : null}
          {canEdit ? <StageEditDialog trigger={<button type="button" className="inline-flex h-11 items-center gap-1.5 rounded-lg border border-border px-3.5 text-sm font-semibold transition-colors hover:bg-accent"><IconPlus className="size-4" /> 新增階段</button>} /> : null}
        </div>
      </div>

      <div className="relative px-4 py-6 sm:px-6 md:py-8">
        <div className="tl-spine" aria-hidden><span style={{ height: `${spinePct}%` }} /></div>
        <ol className="flex flex-col gap-4 md:gap-5">
          {stages.map((s, i) => {
            const left = i % 2 === 0;
            const isCur = s.status === "current";
            const open = s.id === openId;
            const tasks = stageTasksFor(s, role);
            const first = tasks.find((t) => !t.done);
            return (
              <li key={s.id} ref={isCur ? curRef : undefined} className={`tl-row ${left ? "tl-left" : "tl-right"}`} data-status={s.status}>
                <div className="tl-connector" aria-hidden />
                <div className="tl-dot" aria-hidden>{s.status === "done" ? <IconCheck className="size-3" strokeWidth={3} /> : null}</div>
                <article className={`tl-card ${open ? "tl-open" : ""}`}>
                  {isCur ? <span className="tl-tab" aria-hidden>現在</span> : null}
                  <button type="button" onClick={() => setOpenId(open ? "" : s.id)} aria-expanded={open} className="flex min-h-11 w-full items-center gap-3 px-4 py-3 text-left">
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-[16px] font-extrabold tracking-tight">{s.title}</span>
                        <span className="tabular text-xs text-muted-foreground">{range(s.from, s.to)}</span>
                      </span>
                    </span>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${isCur ? "bg-brand text-brand-foreground" : s.status === "done" ? "bg-success-subtle text-success-on-subtle" : "bg-muted text-muted-foreground"}`}>{STATUS_WORD[s.status]}</span>
                  </button>
                  <div className="tl-body" data-open={open}>
                    <div className="min-h-0 overflow-hidden">
                      <div className="border-t border-border/70 px-4 pt-3 pb-4">
                        <p className="text-sm leading-relaxed">{s.summary}{s.tag ? <span className="ml-2 text-xs text-muted-foreground">{s.tag}</span> : null}</p>
                        {tasks.length ? (
                          <ul className="mt-3 flex flex-col gap-1.5">
                            {tasks.map((t) => (
                              <li key={t.label} className="flex items-center gap-2.5 text-sm">
                                <span className={`inline-flex size-4 shrink-0 items-center justify-center rounded-full ${t.done ? "bg-success text-success-foreground" : "border-2 border-border"}`}>{t.done ? <IconCheck className="size-2.5" strokeWidth={3} /> : null}</span>
                                <span className={`min-w-0 flex-1 truncate ${t.done ? "text-muted-foreground line-through decoration-border" : "font-medium"}`}>{t.label}</span>
                                {t.due ? <span className="tabular shrink-0 text-xs text-muted-foreground">{md(t.due)}</span> : null}
                              </li>
                            ))}
                          </ul>
                        ) : <p className="mt-2 text-xs text-muted-foreground">這個階段沒有你要做的事。</p>}
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          {isCur && first ? <Link href={first.href} className="btn-fju h-10 rounded-lg px-4 text-sm">{PRIMARY_LABEL[first.href] ?? "前往"}</Link> : null}
                          {canEdit ? <StageEditDialog stage={s} trigger={<button type="button" className="inline-flex h-10 items-center gap-1 rounded-lg px-2.5 text-xs font-semibold text-primary transition-colors hover:bg-accent"><IconPencil className="size-3.5" /> 編輯階段與日期</button>} /> : null}
                        </div>
                      </div>
                    </div>
                  </div>
                </article>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
