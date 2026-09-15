"use client";

import { useState } from "react";
import { IconPencil } from "@tabler/icons-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { buttonVariants } from "@/components/ui/button";
import { INPUT, Stamp, TEXTAREA, fakeTime } from "@/components/dashboard/stamp";

type Target = { key: string; label: string; value: number };

/**
 * 管理員更正（規格 §7.5；Codex 09-10 A-04）：標題明寫「更正 第 02 組・系統驗收 階段成績」，
 * 可選要更正哪位評審的分數或階段平均；保留原值、新值、原因；原始老師輸入不覆蓋。
 */
export function OverrideDialog({ groupNo, stageName, evaluators, average }: { groupNo: string; stageName: string; evaluators: { name: string; score: number }[]; average: number }) {
  const targets: Target[] = [...evaluators.map((e) => ({ key: e.name, label: `${e.name} 老師的分數`, value: e.score })), { key: "avg", label: "階段平均", value: average }];
  const [target, setTarget] = useState(targets[targets.length - 1].key);
  const cur = targets.find((t) => t.key === target)!;
  const [value, setValue] = useState(cur.value.toFixed(2));
  const [reason, setReason] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  function pick(k: string) { setTarget(k); setValue(targets.find((t) => t.key === k)!.value.toFixed(2)); setError(null); }
  function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = Number(value);
    if (Number.isNaN(n) || n < 0 || n > 100) return setError("新值需介於 0–100");
    if (!reason.trim()) return setError("理由不能空白，會寫進操作紀錄");
    setDone(true);
  }
  return (
    <Dialog onOpenChange={(o) => { if (!o) { setDone(false); setReason(""); setError(null); } }}>
      <DialogTrigger render={<button type="button" className={buttonVariants({ size: "sm", variant: "outline", className: "press rounded-lg" })} />}><IconPencil /> 更正</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        {done ? (
          <Stamp label="已更正" title={`${groupNo}・${stageName}`} description={<span className="tabular">{cur.label}：{cur.value.toFixed(2)} → {Number(value).toFixed(2)}。{fakeTime()}，原值、理由與操作者已寫入紀錄；老師原始輸入不覆蓋。</span>} />
        ) : (
          <form className="flex flex-col gap-4" onSubmit={submit}>
            <div>
              <DialogTitle className="text-lg font-extrabold">更正 {groupNo}・{stageName} 階段成績</DialogTitle>
              <DialogDescription className="mt-1">原始老師輸入不會被覆蓋；更正值另存並附理由。</DialogDescription>
            </div>
            <fieldset>
              <legend className="mb-1.5 text-sm font-semibold">要更正哪一個</legend>
              <div className="flex flex-col gap-1.5">
                {targets.map((t) => (
                  <label key={t.key} className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm transition-colors ${target === t.key ? "border-brand bg-brand-subtle/40" : "border-border hover:border-primary/40"}`}>
                    <span className="flex items-center gap-2"><input type="radio" name={`ov-${groupNo}`} value={t.key} checked={target === t.key} onChange={() => pick(t.key)} className="accent-brand" />{t.label}</span>
                    <span className="tabular font-bold">{t.value.toFixed(2)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-muted px-4 py-3"><p className="text-xs text-muted-foreground">原值</p><p className="tabular text-xl font-extrabold">{cur.value.toFixed(2)}</p></div>
              <label htmlFor={`ov-v-${groupNo}`} className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">新值<input id={`ov-v-${groupNo}`} type="number" step="0.01" min={0} max={100} required value={value} onChange={(e) => { setValue(e.target.value); setError(null); }} className={`${INPUT} tabular h-11 text-xl font-extrabold text-foreground`} aria-describedby={error ? `ov-err-${groupNo}` : undefined} /></label>
            </div>
            <label htmlFor={`ov-r-${groupNo}`} className="flex flex-col gap-1.5 text-sm font-semibold">理由（必填）<textarea id={`ov-r-${groupNo}`} rows={3} value={reason} onChange={(e) => { setReason(e.target.value); setError(null); }} placeholder="例：老師來信更正第 3 項分數誤植" className={TEXTAREA} /></label>
            {error ? <p id={`ov-err-${groupNo}`} role="alert" className="text-sm font-semibold text-destructive">{error}</p> : null}
            <button type="submit" className="btn-fju h-11 text-sm">確認更正</button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
