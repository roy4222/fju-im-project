"use client";

import Link from "next/link";
import { useState } from "react";
import { IconArrowLeft, IconArrowRight, IconBell, IconCheck, IconClipboardText, IconFileUpload, IconFolders, IconLink, IconPencilPlus, IconCalendar, IconAlignLeft, IconCursorText, IconTargetArrow } from "@tabler/icons-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { buttonVariants } from "@/components/ui/button";
import { PLACEMENT_LABEL, type Placement } from "@/lib/fixtures";

/**
 * 新增項目（Roy 2026-09-10：三欄拖拉編輯器「不太好用」→ 新增改成跳出視窗三步驟）。
 * 大多數項目只是「公告＋附件」或「收一個檔案」，三步就結束；要細調欄位才進完整編輯器（/editor/[id]）。
 * 規格 §4.4 拖拉編輯器仍在，這裡是它前面的快速通道。
 */
const KINDS: { key: Placement; icon: typeof IconBell; hint: string }[] = [
  { key: "news", icon: IconBell, hint: "公告、競賽資訊，可附檔案" },
  { key: "resource", icon: IconFolders, hint: "給大家下載的檔案或連結" },
  { key: "submission", icon: IconClipboardText, hint: "指定組別在截止前上傳或填寫" },
  { key: "requirement", icon: IconTargetArrow, hint: "題目、計畫書這類專題需求" },
];
const AUDIENCES = ["本屆學生", "全部老師", "所有已登入使用者", "公開訪客", "指定組別"];
const QUICK_FIELDS = [
  { key: "file", label: "檔案上傳", icon: IconFileUpload },
  { key: "text", label: "短文字", icon: IconCursorText },
  { key: "textarea", label: "長文字", icon: IconAlignLeft },
  { key: "url", label: "網址", icon: IconLink },
  { key: "date", label: "日期", icon: IconCalendar },
];
const input = "h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none transition-[border-color,box-shadow] focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25";

export function NewItemDialog({ base, trigger }: { base: string; trigger?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [kind, setKind] = useState<Placement>("news");
  const [title, setTitle] = useState("");
  const [audience, setAudience] = useState(AUDIENCES[0]);
  const [dueAt, setDueAt] = useState("");
  const [summary, setSummary] = useState("");
  const [attached, setAttached] = useState(0);
  const [fields, setFields] = useState<string[]>(["file"]);
  const [done, setDone] = useState<null | "published" | "draft">(null);
  const collects = kind === "submission" || kind === "requirement";
  const canNext = step === 0 ? title.trim().length > 0 && (!collects || dueAt) : true;

  function reset() { setStep(0); setKind("news"); setTitle(""); setAudience(AUDIENCES[0]); setDueAt(""); setSummary(""); setAttached(0); setFields(["file"]); setDone(null); }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setTimeout(reset, 200); }}>
      <DialogTrigger render={trigger ? <span /> : <button type="button" className="btn-fju h-10 px-4 text-sm" />}>
        {trigger ?? <><IconPencilPlus className="size-4" /> 新增項目</>}
      </DialogTrigger>
      <DialogContent className="p-0 sm:max-w-2xl" showCloseButton={!done}>
        {done ? (
          <div className="flex flex-col items-center gap-3 px-8 py-10 text-center">
            <span className="inline-flex size-14 items-center justify-center rounded-full bg-success-subtle text-success-on-subtle"><IconCheck className="size-7" /></span>
            <DialogTitle className="text-xl font-extrabold">{done === "published" ? "已發布" : "已存成草稿"}</DialogTitle>
            <DialogDescription className="max-w-md">
              「{title}」{done === "published" ? `已出現在${PLACEMENT_LABEL[kind]}${collects ? `，${audience}會收到通知，${dueAt} 截止` : ""}。` : "還沒有人看得到，之後可從工作台繼續編輯。"}
            </DialogDescription>
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={() => setOpen(false)} className={buttonVariants({ variant: "outline", className: "press rounded-lg" })}>回工作台</button>
              <Link href={`${base}/editor/new`} className={buttonVariants({ className: "press rounded-lg" })}>細調欄位</Link>
            </div>
          </div>
        ) : (
          <div className="flex flex-col">
            <div className="flex items-center justify-between border-b border-border px-6 py-4">
              <div>
                <DialogTitle className="text-lg font-extrabold">新增項目</DialogTitle>
                <DialogDescription className="mt-0.5">{["選類型、寫標題", "內容與附件", "確認後發布"][step]}</DialogDescription>
              </div>
              <ol className="mr-8 flex shrink-0 items-center gap-2 whitespace-nowrap" aria-label="步驟">
                {["類型", "內容", "發布"].map((l, i) => (
                  <li key={l} className="flex items-center gap-2 text-xs font-semibold">
                    <span className={`inline-flex size-6 items-center justify-center rounded-full ${i < step ? "bg-success text-success-foreground" : i === step ? "bg-brand text-brand-foreground" : "bg-muted text-muted-foreground"}`}>{i < step ? <IconCheck className="size-3.5" strokeWidth={3} /> : i + 1}</span>
                    <span className={i === step ? "" : "text-muted-foreground"}>{l}</span>
                    {i < 2 ? <span className="h-px w-5 bg-border" /> : null}
                  </li>
                ))}
              </ol>
            </div>

            <div className="flex min-h-[340px] flex-col gap-5 px-6 py-5">
              {step === 0 ? (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    {KINDS.map((k) => {
                      const Icon = k.icon; const on = kind === k.key;
                      return (
                        <button key={k.key} type="button" onClick={() => setKind(k.key)} aria-pressed={on} className={`press flex items-start gap-3 rounded-xl border-2 p-4 text-left transition-colors ${on ? "border-brand bg-brand-subtle/40" : "border-border hover:border-primary/40"}`}>
                          <span className={`inline-flex size-10 shrink-0 items-center justify-center rounded-lg ${on ? "bg-brand text-brand-foreground" : "bg-muted text-foreground"}`}><Icon className="size-5" /></span>
                          <span className="min-w-0"><span className="block text-sm font-bold">{PLACEMENT_LABEL[k.key]}</span><span className="block text-xs text-muted-foreground">{k.hint}</span></span>
                        </button>
                      );
                    })}
                  </div>
                  <label className="flex flex-col gap-1.5 text-sm font-semibold">標題<input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={kind === "news" ? "例：114 學年度專題說明會" : "例：系統驗收簡報與說明文件"} className={input} /></label>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="flex flex-col gap-1.5 text-sm font-semibold">對象<select value={audience} onChange={(e) => setAudience(e.target.value)} className={input}>{AUDIENCES.map((a) => <option key={a}>{a}</option>)}</select></label>
                    <label className="flex flex-col gap-1.5 text-sm font-semibold">{collects ? "截止日" : "截止日（選填）"}<input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} className={input} /></label>
                  </div>
                </>
              ) : step === 1 ? (
                <>
                  <label className="flex flex-col gap-1.5 text-sm font-semibold">說明<textarea rows={4} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder={collects ? "要交什麼、格式、上限。學生在作業說明看到的就是這段。" : "公告內容。"} className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none transition-[border-color,box-shadow] focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25" /></label>
                  <button type="button" onClick={() => setAttached((n) => n + 1)} className="flex items-center gap-3 rounded-xl border border-dashed border-border px-4 py-3 text-left text-sm transition-colors hover:border-brand hover:bg-brand-subtle/30">
                    <IconFileUpload className="size-5 text-brand" />
                    <span className="flex-1"><span className="block font-semibold">附件</span><span className="block text-xs text-muted-foreground">{attached ? `已加入 ${attached} 個檔案` : "拖放或點擊加入 PDF、圖片、連結"}</span></span>
                  </button>
                  {collects ? (
                    <div className="flex flex-col gap-2">
                      <p className="text-sm font-semibold">要學生交什麼 <span className="font-normal text-muted-foreground">・勾幾個就有幾個欄位；要細調再進完整編輯器</span></p>
                      <div className="flex flex-wrap gap-2">
                        {QUICK_FIELDS.map((f) => {
                          const Icon = f.icon; const on = fields.includes(f.key);
                          return <button key={f.key} type="button" aria-pressed={on} onClick={() => setFields((xs) => (on ? xs.filter((x) => x !== f.key) : [...xs, f.key]))} className={`press inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm font-semibold transition-colors ${on ? "border-brand bg-brand text-brand-foreground" : "border-border bg-background hover:border-primary/40"}`}><Icon className="size-4" />{f.label}</button>;
                        })}
                      </div>
                    </div>
                  ) : null}
                </>
              ) : (
                <>
                  <dl className="grid gap-x-8 gap-y-3 rounded-xl bg-muted/40 p-5 text-sm sm:grid-cols-2">
                    {([["類型", PLACEMENT_LABEL[kind]], ["標題", title], ["對象", audience], ["截止", dueAt || "無"], ["附件", attached ? `${attached} 個` : "無"], ...(collects ? [["欄位", fields.length ? fields.map((k) => QUICK_FIELDS.find((f) => f.key === k)!.label).join("、") : "無"]] : [])] as [string, string][]).map(([k, v]) => (
                      <div key={k} className="flex gap-4"><dt className="w-12 shrink-0 text-muted-foreground">{k}</dt><dd className="font-semibold">{v}</dd></div>
                    ))}
                  </dl>
                  <div className="rounded-xl border border-border p-4 text-sm">
                    <p className="text-xs font-bold tracking-[0.06em] text-muted-foreground">學生看到的樣子</p>
                    <p className="mt-2 text-[15px] font-bold">{title}</p>
                    <p className="mt-1 text-muted-foreground">{summary || "（沒有說明）"}</p>
                    {collects ? <p className="mt-2 text-xs text-brand">{dueAt} 23:59 截止・出現在作業區與行事曆</p> : null}
                  </div>
                </>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-border px-6 py-4">
              <button type="button" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0} className={buttonVariants({ variant: "ghost", className: "press rounded-lg disabled:opacity-40" })}><IconArrowLeft className="size-4" /> 上一步</button>
              <div className="flex gap-2">
                {step === 2 ? <button type="button" onClick={() => setDone("draft")} className={buttonVariants({ variant: "outline", className: "press rounded-lg" })}>存草稿</button> : null}
                {step < 2 ? (
                  <button type="button" disabled={!canNext} onClick={() => setStep((s) => s + 1)} className="btn-fju h-10 rounded-lg px-5 text-sm disabled:opacity-40">下一步 <IconArrowRight className="size-4" /></button>
                ) : (
                  <button type="button" onClick={() => setDone("published")} className="btn-fju h-10 rounded-lg px-5 text-sm">發布</button>
                )}
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
