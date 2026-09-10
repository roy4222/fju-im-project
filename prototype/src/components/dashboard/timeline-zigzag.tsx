"use client";

import Link from "next/link";
import { useState } from "react";
import { IconCheck, IconPencil, IconPlus } from "@tabler/icons-react";
import { buttonVariants } from "@/components/ui/button";
import { Ring } from "@/components/dashboard/charts";
import { daysUntil, stageTasksFor, type Role, type Stage } from "@/lib/fixtures";

function md(d: string) { return d.slice(5).replace("-", "/"); }

/**
 * 專題時間軸 B「直立蛇形」（Roy 2026-09-10 從畫布挑的），加強版：
 * - 只有三色：深藍（脊椎、完成）、橘（現在）、淡藍（底）。
 * - 立體感用 CSS 3D：卡片朝脊椎微傾（perspective＋rotateY）、hover 浮起、目前階段微微漂浮；
 *   脊椎是發光漸層。進頁面時卡片依序浮現、連接線像畫出來一樣延伸。
 * - Three.js 先不上（600KB 以上、字與點擊都要另外處理）；Roy 看過如果還要更立體再加 3D 物件當點綴。
 * - 管理員可調整：右上「新增階段」、每張卡「編輯」（原型只做入口）。
 */
export function TimelineZigzag({ stages, role, canEdit = false }: { stages: Stage[]; role: Role; canEdit?: boolean }) {
  const cur = stages.find((s) => s.status === "current") ?? stages[0];
  const [openId, setOpenId] = useState(cur.id);
  const doneCount = stages.filter((s) => s.status === "done").length;
  const spinePct = ((doneCount + 0.5) / stages.length) * 100;

  return (
    <div className="tl-wrap dash-card tint tint-sky relative overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 pt-5">
        <div>
          <h2 className="text-[15px] font-bold">全部階段</h2>
          <p className="text-xs text-muted-foreground">點一張卡看那個階段要做的事</p>
        </div>
        {canEdit ? <button type="button" className="btn-fju h-9 rounded-lg px-3 text-sm"><IconPlus className="size-4" /> 新增階段</button> : null}
      </div>

      <div className="relative px-4 py-8 sm:px-8">
        <div className="tl-spine" aria-hidden><span style={{ height: `${spinePct}%` }} /></div>
        <ol className="flex flex-col gap-6">
          {stages.map((s, i) => {
            const left = i % 2 === 0;
            const open = s.id === openId;
            const tasks = stageTasksFor(s, role);
            const remain = daysUntil(s.to);
            const total = Math.max(1, Math.round((new Date(s.to).getTime() - new Date(s.from).getTime()) / 86400000));
            const pct = s.status === "done" ? 100 : s.status === "upcoming" ? 0 : Math.min(100, Math.max(0, Math.round(((total - remain) / total) * 100)));
            return (
              <li key={s.id} className={`tl-row ${left ? "tl-left" : "tl-right"}`} data-status={s.status} style={{ animationDelay: `${i * 90}ms` }}>
                <div className="tl-connector" aria-hidden />
                <div className="tl-dot" aria-hidden>
                  {s.status === "done" ? <IconCheck className="size-3.5" strokeWidth={3} /> : null}
                </div>
                <article className={`tl-card ${open ? "tl-open" : ""}`}>
                  <button type="button" onClick={() => setOpenId(open ? "" : s.id)} aria-expanded={open} className="flex w-full items-start gap-3 px-5 pt-4 pb-3 text-left">
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="tabular text-[11px] font-bold tracking-[0.06em] text-muted-foreground">第 {i + 1} 階段</span>
                        {s.status === "current" ? <span className="rounded-full bg-brand px-2 py-0.5 text-[10px] font-bold text-brand-foreground">現在</span> : s.status === "done" ? <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary">完成</span> : null}
                      </span>
                      <span className={`mt-0.5 block text-[17px] font-extrabold tracking-tight ${s.status === "current" ? "text-brand" : ""}`}>{s.title}</span>
                      <span className="tabular block text-xs text-muted-foreground">{md(s.from)} – {md(s.to)}{s.tag ? `・${s.tag}` : ""}</span>
                    </span>
                    {s.status === "current" ? (
                      <Ring value={pct} size={52} stroke={6} color="var(--brand)"><span className="tabular text-[11px] font-extrabold">{remain} 天</span></Ring>
                    ) : null}
                  </button>
                  {open ? (
                    <div className="border-t border-border/70 px-5 pt-3 pb-4">
                      <p className="text-sm leading-relaxed">{s.summary}</p>
                      {tasks.length ? (
                        <ul className="mt-3 flex flex-col gap-2">
                          {tasks.map((t) => (
                            <li key={t.label} className="flex items-center gap-2.5 text-sm">
                              <span className={`inline-flex size-5 shrink-0 items-center justify-center rounded-md ${t.done ? "bg-primary text-primary-foreground" : "border-2 border-border"}`}>{t.done ? <IconCheck className="size-3" strokeWidth={3} /> : null}</span>
                              <span className={`min-w-0 flex-1 truncate font-semibold ${t.done ? "text-muted-foreground line-through decoration-border" : ""}`}>{t.label}</span>
                              {t.due ? <span className="tabular text-xs text-muted-foreground">{md(t.due)}</span> : null}
                              {!t.done && s.status !== "upcoming" ? <Link href={t.href} className={buttonVariants({ size: "sm", variant: s.status === "current" ? "default" : "outline", className: "press h-7 rounded-lg px-2.5 text-xs" })}>前往</Link> : null}
                            </li>
                          ))}
                        </ul>
                      ) : <p className="mt-2 text-xs text-muted-foreground">這個階段沒有你要做的事。</p>}
                      {canEdit ? <button type="button" className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-primary hover:text-brand"><IconPencil className="size-3.5" /> 編輯階段與日期</button> : null}
                    </div>
                  ) : null}
                </article>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
