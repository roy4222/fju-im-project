"use client";

import { useState } from "react";
import { IconFileTypePdf, IconPlus } from "@tabler/icons-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { buttonVariants } from "@/components/ui/button";
import { INPUT, Stamp, fakeTime } from "@/components/dashboard/stamp";
import { GROUPS, SIGNOFF } from "@/lib/fixtures";

/**
 * 新增簽核（Codex 09-10 A-04）：標題、版本、對象（本屆全部／指定組別）、上傳 PDF、發布。
 * 系辦不能代替學生同意：發布後每位學生與指導老師各自登入同意。
 */
export function NewSignoffDialog() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [scope, setScope] = useState<"all" | "some">("all");
  const [picked, setPicked] = useState<string[]>([]);
  const [file, setFile] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const version = SIGNOFF.packageVersion + 1;
  const targets = scope === "all" ? GROUPS : GROUPS.filter((g) => picked.includes(g.id));
  const students = targets.reduce((a, g) => a + g.members.length, 0);
  const teachers = new Set(targets.map((g) => g.advisorId).filter(Boolean)).size;

  function reset() { setTitle(""); setScope("all"); setPicked([]); setFile(null); setError(null); setDone(false); }
  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return setError("標題不能空白");
    if (scope === "some" && picked.length === 0) return setError("指定組別至少要選 1 組");
    if (!file) return setError("要先上傳同意書 PDF，學生才有東西可看");
    setDone(true);
  }
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setTimeout(reset, 200); }}>
      <DialogTrigger render={<button type="button" className="btn-fju h-10 px-4 text-sm" />}><IconPlus className="size-4" /> 新增簽核</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        {done ? (
          <Stamp label="已發布" title={`${title} v${version}`} description={<>{fakeTime()}・已通知 {targets.length} 組、{students} 位學生與 {teachers} 位老師。系辦不能代替任何人同意，每個人要自己登入按同意。</>}>
            <button type="button" onClick={() => setOpen(false)} className={buttonVariants({ variant: "outline", size: "lg", className: "press mt-1 rounded-lg" })}>關閉</button>
          </Stamp>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div>
              <DialogTitle className="text-lg font-extrabold">新增簽核</DialogTitle>
              <DialogDescription className="mt-1">建立一份要全組逐人同意的文件。系辦只能發布、重開、重置，不能代替學生或老師同意。</DialogDescription>
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_6rem]">
              <label htmlFor="ns-title" className="flex flex-col gap-1.5 text-sm font-semibold">標題<input id="ns-title" value={title} onChange={(e) => { setTitle(e.target.value); setError(null); }} placeholder={SIGNOFF.title} className={INPUT} autoFocus /></label>
              <label htmlFor="ns-ver" className="flex flex-col gap-1.5 text-sm font-semibold">版本<input id="ns-ver" value={`v${version}`} readOnly className={`${INPUT} tabular bg-muted`} /></label>
            </div>
            <fieldset>
              <legend className="mb-1.5 text-sm font-semibold">對象</legend>
              <div className="flex gap-2">
                {([["all", `本屆全部組別（${GROUPS.length}）`], ["some", "指定組別"]] as const).map(([k, l]) => (
                  <label key={k} className={`flex flex-1 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors ${scope === k ? "border-brand bg-brand-subtle/40" : "border-border hover:border-primary/40"}`}><input type="radio" name="ns-scope" checked={scope === k} onChange={() => { setScope(k); setError(null); }} className="accent-brand" />{l}</label>
                ))}
              </div>
              {scope === "some" ? (
                <ul className="mt-2 grid max-h-40 grid-cols-3 gap-1 overflow-y-auto rounded-lg border border-border p-2">
                  {GROUPS.map((g) => { const on = picked.includes(g.id); return <li key={g.id}><label className={`flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-sm ${on ? "bg-brand-subtle/60 font-semibold" : "hover:bg-accent"}`}><input type="checkbox" checked={on} onChange={() => { setPicked((xs) => (on ? xs.filter((x) => x !== g.id) : [...xs, g.id])); setError(null); }} className="accent-brand" /><span className="tabular">{g.no}</span></label></li>; })}
                </ul>
              ) : null}
              <p className="mt-1.5 text-xs text-muted-foreground">會通知 {targets.length} 組・{students} 位學生・{teachers} 位老師</p>
            </fieldset>
            <label className={`flex cursor-pointer items-center gap-3 rounded-lg border border-dashed px-4 py-3 text-sm transition-colors ${file ? "border-brand bg-brand-subtle/30" : "border-border hover:border-brand hover:bg-brand-subtle/30"}`}>
              <IconFileTypePdf className="size-5 text-destructive" />
              <span className="min-w-0 flex-1"><span className="block font-semibold">{file ?? "上傳同意書 PDF"}</span><span className="block text-xs text-muted-foreground">{file ? "學生在後台直接看這份" : "只收 PDF，上限 10 MB"}</span></span>
              <input type="file" accept="application/pdf" className="sr-only" onChange={(e) => { setFile(e.target.files?.[0]?.name ?? null); setError(null); }} />
            </label>
            {error ? <p role="alert" className="text-sm font-semibold text-destructive">{error}</p> : null}
            <button type="submit" className="btn-fju h-11 text-sm">發布 v{version} 並通知</button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
