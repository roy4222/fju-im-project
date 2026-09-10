"use client";

import { useMemo, useState } from "react";
import { IconLock, IconPlus, IconTrash } from "@tabler/icons-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { buttonVariants } from "@/components/ui/button";
import { INPUT, SaveDot, Stamp, fakeTime } from "@/components/dashboard/stamp";
import { GRADING_SCHEME, GROUPS, TEACHERS } from "@/lib/fixtures";

type Input = "number" | "letter";
type Item = { id: string; name: string; weight: number; input: Input };
type StageDraft = { id: string; name: string; weight: number; items: Item[] };

const input = `${INPUT.replace("w-full ", "")} h-9`;
const num = `${input} tabular w-20 text-right`;

/**
 * 建立新方案版本（Codex 09-10 A-04）：階段權重表 → 每階段項目（權重、輸入型別）→ 評審分配（每組 2 位）→ 鎖定前檢查。
 * 從目前方案 v2 複製起草；原型只存本頁。
 */
export function SchemeDialog() {
  const [open, setOpen] = useState(false);
  const [stages, setStages] = useState<StageDraft[]>(() => GRADING_SCHEME.stages.map((s) => ({ id: s.id, name: s.name, weight: s.weight, items: s.items.map((it) => ({ id: it.id, name: it.name, weight: it.weight, input: it.input })) })));
  const [assign, setAssign] = useState<Record<string, [string, string]>>(() => Object.fromEntries(GROUPS.map((g, i) => [g.id, [TEACHERS[i % 4].id, TEACHERS[(i + 2) % 4].id]])));
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [done, setDone] = useState<null | "draft" | "locked">(null);
  const version = GRADING_SCHEME.version + 1;

  const stageSum = stages.reduce((a, s) => a + s.weight, 0);
  const problems = useMemo(() => {
    const out: string[] = [];
    if (stageSum !== 100) out.push(`階段權重合計 ${stageSum}，需為 100`);
    stages.forEach((s) => {
      if (!s.name.trim()) out.push("有階段沒有名稱");
      if (s.items.length === 0) out.push(`「${s.name}」尚未建立項目`);
      else {
        const sum = s.items.reduce((a, it) => a + it.weight, 0);
        if (sum !== 100) out.push(`「${s.name}」項目權重合計 ${sum}，需為 100`);
        if (s.items.some((it) => !it.name.trim())) out.push(`「${s.name}」有項目沒有名稱`);
      }
    });
    const dup = GROUPS.filter((g) => assign[g.id][0] === assign[g.id][1]).map((g) => g.no);
    if (dup.length) out.push(`${dup.join("、")} 兩位評審相同`);
    return out;
  }, [stages, stageSum, assign]);

  function mut(fn: (s: StageDraft[]) => StageDraft[]) { setStages(fn); setDirty(true); }
  function updStage(id: string, patch: Partial<StageDraft>) { mut((xs) => xs.map((s) => (s.id === id ? { ...s, ...patch } : s))); }
  function updItem(sid: string, iid: string, patch: Partial<Item>) { mut((xs) => xs.map((s) => (s.id === sid ? { ...s, items: s.items.map((it) => (it.id === iid ? { ...it, ...patch } : it)) } : s))); }
  function addItem(sid: string) { mut((xs) => xs.map((s) => (s.id === sid ? { ...s, items: [...s.items, { id: `${sid}-${Date.now()}`, name: "", weight: 0, input: "number" }] } : s))); }
  function rmItem(sid: string, iid: string) { mut((xs) => xs.map((s) => (s.id === sid ? { ...s, items: s.items.filter((it) => it.id !== iid) } : s))); }
  function save() { setSavedAt(fakeTime().slice(11)); setDirty(false); }
  function lock() { if (problems.length) return; setDone("locked"); }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setTimeout(() => setDone(null), 200); }}>
      <DialogTrigger render={<button type="button" className="btn-fju h-10 px-4 text-sm" />}><IconPlus className="size-4" /> 建立新方案版本</DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto p-0 sm:max-w-3xl">
        {done ? (
          <div className="px-6 py-8">
            <Stamp label={done === "locked" ? "已鎖定" : "已存草稿"} title={`評分方案 v${version}`} description={<>{fakeTime()}・{done === "locked" ? "老師現在看到的評分表就是這一版；改結構要再建新版本，已送出的評分不受影響。" : "只有系辦看得到；鎖定前老師仍用 v2。"}</>}>
              <button type="button" onClick={() => setOpen(false)} className={buttonVariants({ variant: "outline", size: "lg", className: "press mt-1 rounded-lg" })}>關閉</button>
            </Stamp>
          </div>
        ) : (
          <div className="flex flex-col">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-6 py-4 pr-14">
              <div>
                <DialogTitle className="text-lg font-extrabold">建立評分方案 v{version}</DialogTitle>
                <DialogDescription className="mt-0.5">從 v{GRADING_SCHEME.version} 複製起草。鎖定後結構不能改，只能再建新版本。</DialogDescription>
              </div>
              <SaveDot saved={!!savedAt && !dirty} at={savedAt ?? undefined} />
            </div>

            <section className="border-b border-border px-6 py-4">
              <h3 className="text-[15px] font-bold">1・階段權重 <span className={`ml-2 tabular text-xs font-semibold ${stageSum === 100 ? "text-success-on-subtle" : "text-destructive"}`}>合計 {stageSum}％</span></h3>
              <ul className="mt-3 flex flex-col gap-2">
                {stages.map((s) => (
                  <li key={s.id} className="flex items-center gap-3">
                    <label className="sr-only" htmlFor={`sn-${s.id}`}>階段名稱</label>
                    <input id={`sn-${s.id}`} value={s.name} onChange={(e) => updStage(s.id, { name: e.target.value })} className={`${input} max-w-xs`} />
                    <label className="sr-only" htmlFor={`sw-${s.id}`}>階段權重</label>
                    <input id={`sw-${s.id}`} type="number" min={0} max={100} value={s.weight} onChange={(e) => updStage(s.id, { weight: Number(e.target.value) })} className={num} />
                    <span className="text-sm text-muted-foreground">％</span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="border-b border-border px-6 py-4">
              <h3 className="text-[15px] font-bold">2・各階段項目</h3>
              <div className="mt-3 grid gap-6 md:grid-cols-2">
                {stages.map((s) => {
                  const sum = s.items.reduce((a, it) => a + it.weight, 0);
                  return (
                    <div key={s.id}>
                      <div className="flex items-center justify-between"><p className="text-sm font-bold">{s.name || "（未命名）"}</p><span className={`tabular text-xs font-semibold ${s.items.length && sum === 100 ? "text-success-on-subtle" : "text-destructive"}`}>{s.items.length ? `項目合計 ${sum}％` : "尚未建立項目"}</span></div>
                      <ul className="mt-2 flex flex-col gap-1.5">
                        {s.items.map((it, k) => (
                          <li key={it.id} className="flex items-center gap-2">
                            <label className="sr-only" htmlFor={`in-${it.id}`}>第 {k + 1} 項名稱</label>
                            <input id={`in-${it.id}`} value={it.name} onChange={(e) => updItem(s.id, it.id, { name: e.target.value })} placeholder={`第 ${k + 1} 項`} className={`${input} min-w-0 flex-1`} />
                            <label className="sr-only" htmlFor={`iw-${it.id}`}>第 {k + 1} 項權重</label>
                            <input id={`iw-${it.id}`} type="number" min={0} max={100} value={it.weight} onChange={(e) => updItem(s.id, it.id, { weight: Number(e.target.value) })} className={`${num} w-16`} />
                            <label className="sr-only" htmlFor={`ii-${it.id}`}>輸入型別</label>
                            <select id={`ii-${it.id}`} value={it.input} onChange={(e) => updItem(s.id, it.id, { input: e.target.value as Input })} className={`${input} w-24`}><option value="number">0–100</option><option value="letter">A–F</option></select>
                            <button type="button" onClick={() => rmItem(s.id, it.id)} className={buttonVariants({ size: "icon-sm", variant: "ghost", className: "press shrink-0 rounded-lg" })} aria-label={`刪除第 ${k + 1} 項`}><IconTrash /></button>
                          </li>
                        ))}
                      </ul>
                      <button type="button" onClick={() => addItem(s.id)} className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-primary hover:text-brand"><IconPlus className="size-4" /> 新增項目</button>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="border-b border-border px-6 py-4">
              <h3 className="text-[15px] font-bold">3・評審分配 <span className="ml-2 text-xs font-normal text-muted-foreground">每組 2 位老師；階段成績＝兩位平均</span></h3>
              <ul className="mt-3 grid gap-x-6 gap-y-2 md:grid-cols-2">
                {GROUPS.map((g) => (
                  <li key={g.id} className="grid grid-cols-[4.5rem_1fr_1fr] items-center gap-2 text-sm">
                    <span className="tabular font-semibold">{g.no}</span>
                    {[0, 1].map((k) => (
                      <span key={k}>
                        <label className="sr-only" htmlFor={`ev-${g.id}-${k}`}>{g.no} 評審 {k + 1}</label>
                        <select id={`ev-${g.id}-${k}`} value={assign[g.id][k]} onChange={(e) => { setAssign((a) => ({ ...a, [g.id]: k === 0 ? [e.target.value, a[g.id][1]] : [a[g.id][0], e.target.value] })); setDirty(true); }} className={`${input} ${assign[g.id][0] === assign[g.id][1] ? "border-destructive" : ""}`}>
                          {TEACHERS.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                        </select>
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            </section>

            <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
              <div className="min-w-0 text-sm">
                {problems.length ? <ul className="flex flex-col gap-0.5 text-destructive" role="alert">{problems.map((p) => <li key={p} className="font-semibold">・{p}</li>)}</ul> : <p className="font-semibold text-success-on-subtle">檢查通過：階段與項目權重都是 100，每組 2 位不同評審。</p>}
              </div>
              <div className="flex shrink-0 gap-2">
                <button type="button" onClick={save} className={buttonVariants({ variant: "outline", size: "lg", className: "press rounded-lg" })}>存草稿</button>
                <button type="button" onClick={lock} disabled={problems.length > 0} title={problems.length ? "先修正上面的問題" : undefined} className="btn-fju h-9 px-4 text-sm disabled:cursor-not-allowed disabled:opacity-50"><IconLock className="size-4" /> 鎖定 v{version}</button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
