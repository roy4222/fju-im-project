"use client";

import { useState, type ReactNode } from "react";
import { IconCheck } from "@tabler/icons-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { INPUT, SaveDot, TEXTAREA, fakeTime } from "@/components/dashboard/stamp";
import { MANAGED_ITEMS, SCHEDULE, type Stage } from "@/lib/fixtures";

function md(d: string) { return d ? d.slice(5).replace("-", "/") : "—"; }

/** 收件類事務（可關聯到階段） */
const INTAKE = MANAGED_ITEMS.filter((i) => i.progress);

/**
 * 管理員「時間軸設定」：新增階段／編輯階段與日期（Codex 09-10 A-04）。
 * 左＝表單（名稱、起訖、一句話、關聯事務），右＝學生看到的樣子即時預覽。
 * 原型只存本頁（本地 state）；儲存後顯示實心小圓點＋「已儲存 hh:mm」。新增與編輯共用。
 */
export function StageEditDialog({ stage, trigger }: { stage?: Stage; trigger: ReactNode }) {
  const editing = !!stage;
  const index = stage ? SCHEDULE.findIndex((s) => s.id === stage.id) + 1 : SCHEDULE.length + 1;
  const linkedInit = stage ? INTAKE.filter((i) => i.stage === stage.title).map((i) => i.id) : [];
  const [title, setTitle] = useState(stage?.title ?? "");
  const [from, setFrom] = useState(stage?.from ?? "");
  const [to, setTo] = useState(stage?.to ?? "");
  const [summary, setSummary] = useState(stage?.summary ?? "");
  const [linked, setLinked] = useState<string[]>(linkedInit);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function touch<T>(set: (v: T) => void) { return (v: T) => { set(v); setDirty(true); setError(null); }; }
  function save(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return setError("階段名稱不能空白");
    if (!from || !to) return setError("起訖日期都要填");
    if (to < from) return setError(`結束日 ${md(to)} 早於開始日 ${md(from)}，請對調`);
    setSavedAt(fakeTime().slice(11));
    setDirty(false);
  }
  const linkedItems = INTAKE.filter((i) => linked.includes(i.id));

  return (
    <Dialog>
      <DialogTrigger nativeButton={false} render={<span className="contents" />}>{trigger}</DialogTrigger>
      <DialogContent className="p-0 sm:max-w-3xl">
        <form onSubmit={save} className="grid md:grid-cols-[minmax(0,1fr)_280px]">
          <div className="flex flex-col gap-4 px-6 py-5">
            <div>
              <DialogTitle className="text-lg font-extrabold">{editing ? `編輯第 ${index} 階段` : "新增階段"}</DialogTitle>
              <DialogDescription className="mt-1">學生時間軸與首頁「現在階段」都用這份設定。原型只存本頁。</DialogDescription>
            </div>
            <label htmlFor="st-title" className="flex flex-col gap-1.5 text-sm font-semibold">名稱<input id="st-title" value={title} onChange={(e) => touch(setTitle)(e.target.value)} placeholder="例：系統驗收" className={INPUT} autoFocus={!editing} /></label>
            <div className="grid grid-cols-2 gap-3">
              <label htmlFor="st-from" className="flex flex-col gap-1.5 text-sm font-semibold">開始<input id="st-from" type="date" value={from} onChange={(e) => touch(setFrom)(e.target.value)} className={INPUT} /></label>
              <label htmlFor="st-to" className="flex flex-col gap-1.5 text-sm font-semibold">結束<input id="st-to" type="date" value={to} onChange={(e) => touch(setTo)(e.target.value)} className={INPUT} /></label>
            </div>
            <label htmlFor="st-summary" className="flex flex-col gap-1.5 text-sm font-semibold">一句話說明<textarea id="st-summary" rows={2} value={summary} onChange={(e) => touch(setSummary)(e.target.value)} placeholder="這階段要做什麼，學生會在卡片上看到。" className={TEXTAREA} /></label>
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1.5 text-sm font-semibold">關聯事務 <span className="font-normal text-muted-foreground">・收件類，會列在這階段的待辦</span></legend>
              <ul className="grid gap-1 sm:grid-cols-2">
                {INTAKE.map((i) => {
                  const on = linked.includes(i.id);
                  return (
                    <li key={i.id}>
                      <label className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${on ? "border-brand bg-brand-subtle/40" : "border-border hover:border-primary/40"}`}>
                        <input type="checkbox" checked={on} onChange={() => touch(setLinked)(on ? linked.filter((x) => x !== i.id) : [...linked, i.id])} className="accent-brand" />
                        <span className="min-w-0 flex-1 truncate font-medium">{i.title}</span>
                        {i.dueAt ? <span className="tabular shrink-0 text-xs text-muted-foreground">{md(i.dueAt)}</span> : null}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </fieldset>
            {error ? <p role="alert" className="text-sm font-semibold text-destructive">{error}</p> : null}
            <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
              <SaveDot saved={!!savedAt && !dirty} at={savedAt ?? undefined} />
              <div className="flex items-center gap-2">
                {savedAt && !dirty ? <span className="inline-flex items-center gap-1 text-xs font-semibold text-success-on-subtle"><IconCheck className="size-3.5" /> 已更新（原型只存本頁）</span> : null}
                <button type="submit" className="btn-fju h-9 px-4 text-sm">{editing ? "儲存" : "新增階段"}</button>
              </div>
            </div>
          </div>
          {/* 學生看到的樣子 */}
          <aside className="flex flex-col gap-3 rounded-b-xl bg-muted/40 px-5 py-5 md:rounded-r-xl md:rounded-bl-none md:border-l md:border-border">
            <p className="text-[11px] font-bold tracking-[0.06em] text-muted-foreground">學生看到的樣子</p>
            <div className="dash-card px-4 py-3.5">
              <p className="tabular text-[11px] font-bold tracking-[0.06em] text-muted-foreground">第 {index} 階段</p>
              <p className="mt-0.5 text-[17px] font-extrabold tracking-tight">{title.trim() || <span className="text-muted-foreground">階段名稱</span>}</p>
              <p className="tabular text-xs text-muted-foreground">{md(from)} – {md(to)}</p>
              <p className="mt-2 text-sm leading-relaxed">{summary.trim() || <span className="text-muted-foreground">一句話說明</span>}</p>
              {linkedItems.length ? (
                <ul className="mt-2.5 flex flex-col gap-1.5 border-t border-border/70 pt-2.5">
                  {linkedItems.map((i) => (
                    <li key={i.id} className="flex items-center gap-2 text-sm">
                      <span className="inline-flex size-4 shrink-0 rounded-md border-2 border-border" aria-hidden />
                      <span className="min-w-0 flex-1 truncate font-semibold">{i.title}</span>
                      {i.dueAt ? <span className="tabular text-xs text-muted-foreground">{md(i.dueAt)}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : <p className="mt-2 text-xs text-muted-foreground">尚未關聯事務</p>}
            </div>
          </aside>
        </form>
      </DialogContent>
    </Dialog>
  );
}
