"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { IconCheck, IconDeviceFloppy, IconLock, IconSend } from "@tabler/icons-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { buttonVariants } from "@/components/ui/button";
import { Pill } from "@/components/dashboard/primitives";
import { Ring } from "@/components/dashboard/charts";
import { EVALUATION_QUEUE, GRADING_SCHEME, GROUPS } from "@/lib/fixtures";

const LETTER: Record<string, number> = { A: 95, B: 85, C: 75, D: 65, F: 50 };
type Scores = Record<string, string>;

/** 預設分數：已暫存／已送出的組別有值，未開始為空 */
function seed(groupId: string, state: string): Scores {
  if (state === "pending") return {};
  const n = groupId.charCodeAt(2) + groupId.charCodeAt(3);
  return Object.fromEntries(GRADING_SCHEME.stages[0].items.map((it, i) => [it.id, it.input === "letter" ? ["A", "B", "B", "A"][(n + i) % 4] : String(70 + ((n * (i + 3)) % 28))]));
}

function calc(scores: Scores) {
  const items = GRADING_SCHEME.stages[0].items;
  let sum = 0, filled = 0;
  for (const it of items) {
    const raw = scores[it.id];
    if (raw === undefined || raw === "") continue;
    const pct = it.input === "letter" ? LETTER[raw] ?? 0 : (Number(raw) / it.max) * 100;
    sum += pct * (it.weight / 100);
    filled++;
  }
  return { score: Math.round(sum * 100) / 100, filled, total: items.length };
}

/**
 * 評分工作台（規格 §16.4 方向 C：左側組別清單＋右側評分表）。
 * 老師只看受指派組別；暫存只本人可見；送出後鎖定（§7.4）。
 */
export function GradingWorkbench({ role, initialGroupId }: { role: string; initialGroupId?: string }) {
  const base = `/dashboard/${role}/grading`;
  const [queue, setQueue] = useState(EVALUATION_QUEUE.map((e) => ({ ...e })));
  const [current, setCurrent] = useState(initialGroupId ?? queue[0].groupId);
  const [scores, setScores] = useState<Record<string, Scores>>(() => Object.fromEntries(EVALUATION_QUEUE.map((e) => [e.groupId, seed(e.groupId, e.state)])));
  const [saved, setSaved] = useState<"idle" | "saving" | "saved">("idle");
  const [receipt, setReceipt] = useState<null | { groupNo: string; score: number }>(null);

  const entry = queue.find((q) => q.groupId === current)!;
  const group = GROUPS.find((g) => g.id === current)!;
  const stage = GRADING_SCHEME.stages[0];
  const s = useMemo(() => scores[current] ?? {}, [scores, current]);
  const result = useMemo(() => calc(s), [s]);
  const locked = entry.state === "submitted";
  const complete = result.filled === result.total;

  function set(itemId: string, v: string) {
    setScores((all) => ({ ...all, [current]: { ...all[current], [itemId]: v } }));
    setSaved("idle");
  }
  function stash() {
    setSaved("saving");
    setTimeout(() => {
      setSaved("saved");
      setQueue((q) => q.map((e) => (e.groupId === current && e.state === "pending" ? { ...e, state: "staged" } : e)));
    }, 400);
  }
  function submit() {
    setQueue((q) => q.map((e) => (e.groupId === current ? { ...e, state: "submitted" } : e)));
    setReceipt({ groupNo: entry.groupNo, score: result.score });
  }


  return (
    <div className="grid items-start gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
      {/* 左：組別清單 */}
      <aside className="card-in rounded-xl border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <p className="text-sm font-bold">{stage.name}</p>
          <p className="text-xs text-muted-foreground">我的 {queue.length} 組・占總成績 {stage.weight}%</p>
        </div>
        <ul className="flex flex-col gap-1 p-2">
          {queue.map((e) => {
            const r = calc(scores[e.groupId] ?? {});
            const active = e.groupId === current;
            return (
              <li key={e.groupId}>
                <Link href={`${base}/${e.groupId}`} onClick={(ev) => { ev.preventDefault(); setCurrent(e.groupId); setSaved("idle"); }} className={`flex items-center gap-3 rounded-xl px-3 py-2.5 transition-[background-color,transform] ${active ? "bg-primary text-primary-foreground shadow-sm" : "hover:translate-x-0.5 hover:bg-accent"}`}>
                  <span className="min-w-0 flex-1">
                    <span className={`tabular block text-[11px] ${active ? "text-primary-foreground/80" : "text-muted-foreground"}`}>{e.groupNo}</span>
                    <span className="block truncate text-sm font-semibold">{e.title}</span>
                  </span>
                  {e.state === "submitted" ? <IconLock className={`size-4 ${active ? "" : "text-success"}`} /> : e.state === "staged" ? <span className={`tabular text-xs font-bold ${active ? "" : "text-info"}`}>{r.filled}/{r.total}</span> : <span className={`size-2 rounded-full ${active ? "bg-white/70" : "bg-warning"}`} />}
                </Link>
              </li>
            );
          })}
        </ul>
      </aside>

      {/* 右：評分表 */}
      <section className="card-in rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="tabular text-xs font-semibold text-muted-foreground">{entry.groupNo}</span>
              {locked ? <Pill tone="success"><IconLock className="mr-1 size-3" />已送出・鎖定</Pill> : entry.state === "staged" ? <Pill tone="info">已暫存</Pill> : <Pill tone="warning">未開始</Pill>}
            </div>
            <h2 className="truncate text-lg font-extrabold">{group.title.replace(/（產學：.*）/, "")}</h2>
            <p className="truncate text-xs text-muted-foreground">{group.members.map((m) => m.name).join("、")}</p>
          </div>
          <Ring value={complete ? Math.min(result.score, 100) : (result.filled / result.total) * 100} size={64} color={complete ? "var(--success)" : "var(--info)"}>
            <span className="tabular text-sm font-extrabold">{complete ? result.score.toFixed(0) : `${result.filled}/${result.total}`}</span>
          </Ring>
        </div>

        {/* Roy 2026-09-10 選畫布 B：一格一項、大數字輸入、A–F 用分段鈕；底部即時總分 */}
        <div className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-3">
          {stage.items.map((it) => {
            const v = s[it.id] ?? "";
            const filled = v !== "";
            return (
              <div key={it.id} className={`flex flex-col gap-3 rounded-2xl border p-4 transition-colors ${filled ? "border-brand/60 bg-brand-subtle/20" : "border-border bg-card"}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0"><p className="text-sm font-bold">{it.name}</p><p className="tabular text-xs text-muted-foreground">占 {it.weight}%</p></div>
                  {filled ? <IconCheck className="size-4 shrink-0 text-brand" strokeWidth={3} /> : null}
                </div>
                {it.input === "letter" ? (
                  <div className="flex gap-1" role="radiogroup" aria-label={it.name}>
                    {Object.keys(LETTER).map((l) => (
                      <button key={l} type="button" role="radio" aria-checked={v === l} disabled={locked} onClick={() => set(it.id, l)} className={`press h-11 flex-1 rounded-lg text-sm font-extrabold transition-colors disabled:opacity-60 ${v === l ? "bg-brand text-brand-foreground" : "bg-muted text-foreground hover:bg-accent"}`}>{l}</button>
                    ))}
                  </div>
                ) : (
                  <div className="flex items-baseline gap-2">
                    <input type="number" inputMode="numeric" min={0} max={it.max} value={v} onChange={(e) => set(it.id, e.target.value)} disabled={locked} placeholder="–" className={`tabular h-12 w-24 rounded-xl border-0 px-3 text-center text-[24px] font-extrabold outline-none transition-[box-shadow,background-color] focus-visible:ring-3 focus-visible:ring-brand/25 disabled:opacity-70 ${filled ? "bg-brand-subtle text-foreground" : "bg-muted text-muted-foreground"}`} />
                    <span className="tabular text-sm text-muted-foreground">/ {it.max}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-5 border-t border-border px-5 py-4">
          <div>
            <p className="text-xs font-bold text-muted-foreground">即時階段成績</p>
            <p className="tabular text-[30px] font-extrabold leading-none">{complete ? result.score.toFixed(1) : result.score.toFixed(1)}<span className="ml-1 text-sm font-semibold text-muted-foreground">/ 100</span></p>
          </div>
          <div className="min-w-[160px] flex-1">
            <div className="h-3 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full bg-brand transition-[width] duration-500" style={{ width: `${Math.min(100, result.score)}%` }} /></div>
            <p className="tabular mt-1 text-[11px] text-muted-foreground">{complete ? "七項都填了，可以正式送出" : `還差 ${result.total - result.filled} 項`}・Σ（項目百分成績 × 權重）</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t border-border px-5 py-4">
          <span className="text-xs text-muted-foreground">
            {locked ? "已正式送出；修改需由系辦退回或以更正版本處理。" : saved === "saving" ? "暫存中…" : saved === "saved" ? "已暫存，只有你與系辦看得到。" : "尚未暫存。"}
          </span>
          {!locked ? (
            <div className="ml-auto flex gap-2">
              <button type="button" onClick={stash} className={buttonVariants({ variant: "outline", size: "lg", className: "press rounded-lg" })}><IconDeviceFloppy /> 暫存</button>
              <button type="button" onClick={submit} disabled={!complete} className="btn-fju h-9 px-4 text-sm disabled:cursor-not-allowed disabled:opacity-50"><IconSend className="size-4" /> 正式送出</button>
            </div>
          ) : null}
        </div>
      </section>

      <Dialog open={receipt !== null} onOpenChange={(o) => !o && setReceipt(null)}>
        <DialogContent className="max-w-md">
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="inline-flex size-14 items-center justify-center rounded-full bg-success-subtle text-success-on-subtle"><IconCheck className="size-7" /></span>
            <DialogTitle className="text-xl font-extrabold">已送出評分</DialogTitle>
            <DialogDescription>{receipt?.groupNo}・{stage.name}</DialogDescription>
            <p className="tabular text-4xl font-extrabold">{receipt?.score.toFixed(2)}</p>
            <p className="text-xs text-muted-foreground">已鎖定。多位老師時以算術平均計入階段成績；學生看不到分數。</p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
