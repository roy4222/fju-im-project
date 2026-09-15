"use client";

import Link from "next/link";
import { useState } from "react";
import { IconAlertCircle, IconAlignLeft, IconArrowLeft, IconArrowRight, IconBell, IconCalendar, IconCheck, IconClipboardText, IconCursorText, IconFileUpload, IconFolders, IconLink, IconPencilPlus, IconTargetArrow } from "@tabler/icons-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { buttonVariants } from "@/components/ui/button";
import { GroupPicker } from "@/components/dashboard/group-picker";
import { GROUPS, PLACEMENT_LABEL, type FieldType, type Placement } from "@/lib/fixtures";
import { describeGroups, emptyDraft, newDraftId, saveDraft, type Draft, type Visibility } from "@/lib/draft-store";

/**
 * 新增項目（Roy 2026-09-10：三欄拖拉編輯器「不太好用」→ 新增改成跳出視窗三步驟）。
 * Codex 09-10 A-01／A-02：指定組別要能挑、收件類至少一個欄位、發布前檢查清單；
 * 第一步按下一步就建立草稿 id，「細調欄位」直接開同一個草稿。
 */
const KINDS: { key: Placement; icon: typeof IconBell; hint: string }[] = [
  { key: "news", icon: IconBell, hint: "公告、競賽資訊，可附檔案" },
  { key: "resource", icon: IconFolders, hint: "給大家下載的檔案或連結" },
  { key: "submission", icon: IconClipboardText, hint: "指定組別在截止前上傳或填寫" },
  { key: "requirement", icon: IconTargetArrow, hint: "題目、計畫書這類專題需求" },
];
export const AUDIENCES = ["本屆學生", "全部老師", "所有已登入使用者", "公開訪客", "指定組別"];
const QUICK_FIELDS: { key: FieldType; label: string; icon: typeof IconBell }[] = [
  { key: "file", label: "檔案上傳", icon: IconFileUpload },
  { key: "text", label: "短文字", icon: IconCursorText },
  { key: "textarea", label: "長文字", icon: IconAlignLeft },
  { key: "url", label: "網址", icon: IconLink },
  { key: "date", label: "日期", icon: IconCalendar },
];
const input = "h-10 w-full rounded-lg border border-input bg-background px-3 text-sm font-normal outline-none transition-[border-color,box-shadow] focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25";

/** 對象文案：指定組別寫組號與人數，其他寫範圍與母數 */
export function audienceText(audience: string, groupIds: string[]): string {
  if (audience === "指定組別") {
    const g = describeGroups(groupIds, GROUPS);
    return g.count ? `${g.text.replace(/，共.*$/, "")}（${g.count} 組、${g.students} 位學生）` : "指定組別（還沒選）";
  }
  if (audience === "本屆學生") return `本屆學生（${GROUPS.length} 組、${GROUPS.reduce((a, g) => a + g.members.length, 0)} 位）`;
  return audience;
}

export function NewItemDialog({ base, trigger }: { base: string; trigger?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [kind, setKind] = useState<Placement>("news");
  const [title, setTitle] = useState("");
  const [audience, setAudience] = useState(AUDIENCES[0]);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [visibility, setVisibility] = useState<Visibility>("students");
  const [dueAt, setDueAt] = useState("");
  const [summary, setSummary] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [fields, setFields] = useState<FieldType[]>(["file"]);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [done, setDone] = useState<null | "published" | "draft">(null);
  const collects = kind === "submission" || kind === "requirement";
  const needsGroups = audience === "指定組別";

  /* 檢查清單（第三步用，也拿來擋下一步） */
  const checks = [
    { key: "title", label: "標題", ok: title.trim().length > 0, value: title.trim(), fix: "填標題", step: 0 },
    { key: "audience", label: "對象", ok: !needsGroups || groupIds.length > 0, value: audienceText(audience, groupIds), fix: "至少選一組", step: 0 },
    { key: "due", label: "截止", ok: !collects || !!dueAt, value: dueAt || (collects ? "" : "不設截止"), fix: "收件類要有截止日", step: 0 },
    { key: "fields", label: "欄位", ok: !collects || fields.length > 0, value: collects ? fields.map((k) => QUICK_FIELDS.find((f) => f.key === k)!.label).join("、") : "純公告，不收資料", fix: "至少一個收件欄位", step: 1 },
    { key: "vis", label: "公開範圍", ok: true, value: visibility === "public" ? "網際網路公開" : "登入後學生可見", fix: "", step: 0 },
  ];
  const missing = checks.filter((c) => !c.ok);
  const step0Missing = missing.filter((c) => c.step === 0);
  const step1Missing = missing.filter((c) => c.step === 1);
  const canNext = step === 0 ? step0Missing.length === 0 : step === 1 ? step1Missing.length === 0 : missing.length === 0;

  function toDraft(id: string, status: Draft["status"]): Draft {
    return {
      ...emptyDraft(id, kind),
      title, summary, audience, groupIds: needsGroups ? groupIds : [], dueAt, visibility, status,
      attachments,
      fields: collects ? fields.map((t, i) => ({ id: `q${i + 1}`, type: t, label: QUICK_FIELDS.find((f) => f.key === t)!.label, required: t === "file" })) : [],
      ...(status === "published" ? { publishedAt: emptyDraft(id).updatedAt } : {}),
    };
  }
  /** 第一步按下一步就建立草稿 id，之後每一步都寫回去 */
  function persist(status: Draft["status"] = "draft"): string {
    const id = draftId ?? newDraftId();
    if (!draftId) setDraftId(id);
    saveDraft(toDraft(id, status));
    return id;
  }
  function next() {
    if (!canNext) return;
    persist();
    setStep((s) => s + 1);
  }
  function finish(status: Draft["status"]) {
    persist(status);
    setDone(status === "published" ? "published" : "draft");
  }
  function reset() { setStep(0); setKind("news"); setTitle(""); setAudience(AUDIENCES[0]); setGroupIds([]); setVisibility("students"); setDueAt(""); setSummary(""); setAttachments([]); setFields(["file"]); setDraftId(null); setDone(null); }

  const audienceLine = audienceText(audience, groupIds);

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setTimeout(reset, 200); }}>
      <DialogTrigger nativeButton={!trigger} render={trigger ? <span className="contents" /> : <button type="button" className="btn-fju h-10 px-4 text-sm" />}>
        {trigger ?? <><IconPencilPlus className="size-4" /> 新增項目</>}
      </DialogTrigger>
      <DialogContent className="p-0 sm:max-w-2xl" showCloseButton={!done}>
        {done ? (
          <div className="flex flex-col items-center gap-3 px-8 py-10 text-center">
            <span className="inline-flex size-14 items-center justify-center rounded-full bg-success-subtle text-success-on-subtle"><IconCheck className="size-7" /></span>
            <DialogTitle className="text-xl font-extrabold">{done === "published" ? "已發布" : "已存成草稿"}</DialogTitle>
            <DialogDescription className="max-w-md leading-relaxed">
              {done === "published"
                ? `「${title}」已發布給${audienceLine}${collects ? `，${dueAt} 23:59 截止` : ""}，出現在${PLACEMENT_LABEL[kind]}。通知會在正式版寄出，原型不寄信。`
                : `「${title}」還沒有人看得到；列表會出現一筆草稿，之後可從那裡繼續。`}
            </DialogDescription>
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={() => setOpen(false)} className={buttonVariants({ variant: "outline", size: "lg", className: "press rounded-lg" })}>回列表</button>
              <Link href={`${base}/editor/${draftId}`} className={buttonVariants({ size: "lg", className: "press rounded-lg" })}>細調欄位</Link>
            </div>
          </div>
        ) : (
          <div className="flex flex-col">
            <div className="flex items-center justify-between border-b border-border px-6 py-4">
              <div>
                <DialogTitle className="text-lg font-extrabold">新增項目</DialogTitle>
                <DialogDescription className="mt-0.5">{["選類型、寫標題、定對象", "內容與附件", "發布前檢查"][step]}</DialogDescription>
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

            <div className="flex min-h-[340px] max-h-[70vh] flex-col gap-5 overflow-y-auto px-6 py-5">
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
                    <label className="flex flex-col gap-1.5 text-sm font-semibold">對象
                      <select value={audience} onChange={(e) => { const a = e.target.value; setAudience(a); if (a === "公開訪客") setVisibility("public"); }} className={input}>{AUDIENCES.map((a) => <option key={a}>{a}</option>)}</select>
                    </label>
                    <label className="flex flex-col gap-1.5 text-sm font-semibold">{collects ? "截止日" : "截止日（選填）"}<input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} className={input} /></label>
                  </div>
                  {needsGroups ? (
                    <div className="flex flex-col gap-1.5">
                      <p className="text-sm font-semibold">指定組別 <span className="font-normal text-muted-foreground">・{describeGroups(groupIds, GROUPS).text}</span></p>
                      <GroupPicker value={groupIds} onChange={setGroupIds} />
                    </div>
                  ) : null}
                  <fieldset className="flex flex-col gap-1.5">
                    <legend className="text-sm font-semibold">公開範圍</legend>
                    <div className="flex flex-wrap gap-2">
                      {([["students", "登入後學生可見"], ["public", "網際網路公開"]] as [Visibility, string][]).map(([v, l]) => (
                        <label key={v} className={`inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm font-semibold transition-colors ${visibility === v ? "border-brand bg-brand-subtle/40 text-brand-on-subtle" : "border-border hover:border-primary/40"}`}>
                          <input type="radio" name="visibility" value={v} checked={visibility === v} onChange={() => setVisibility(v)} className="accent-[var(--brand)]" />{l}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                </>
              ) : step === 1 ? (
                <>
                  <label className="flex flex-col gap-1.5 text-sm font-semibold">說明<textarea rows={4} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder={collects ? "要交什麼、格式、上限。學生在作業說明看到的就是這段。" : "公告內容；要排版、插圖片再進完整編輯器。"} className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-normal outline-none transition-[border-color,box-shadow] focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25" /></label>
                  <div className="flex flex-col gap-2">
                    <button type="button" onClick={() => setAttachments((xs) => [...xs, `附件-${xs.length + 1}.pdf`])} className="flex items-center gap-3 rounded-xl border border-dashed border-border px-4 py-3 text-left text-sm transition-colors hover:border-brand hover:bg-brand-subtle/30">
                      <IconFileUpload className="size-5 text-brand" />
                      <span className="flex-1"><span className="block font-semibold">加入附件</span><span className="block text-xs text-muted-foreground">原型：點一下就加一個假檔案</span></span>
                    </button>
                    {attachments.length ? (
                      <ul className="flex flex-wrap gap-1.5">
                        {attachments.map((a) => <li key={a} className="inline-flex h-7 items-center gap-1.5 rounded-full bg-muted px-2.5 text-xs font-semibold">{a}<button type="button" onClick={() => setAttachments((xs) => xs.filter((x) => x !== a))} aria-label={`移除 ${a}`} className="text-muted-foreground hover:text-foreground">×</button></li>)}
                      </ul>
                    ) : null}
                  </div>
                  {collects ? (
                    <div className="flex flex-col gap-2">
                      <p className="text-sm font-semibold">要學生交什麼 <span className="font-normal text-muted-foreground">・勾幾個就有幾個欄位；要細調再進完整編輯器</span></p>
                      <div className="flex flex-wrap gap-2">
                        {QUICK_FIELDS.map((f) => {
                          const Icon = f.icon; const on = fields.includes(f.key);
                          return <button key={f.key} type="button" aria-pressed={on} onClick={() => setFields((xs) => (on ? xs.filter((x) => x !== f.key) : [...xs, f.key]))} className={`press inline-flex h-10 items-center gap-1.5 rounded-lg border px-3 text-sm font-semibold transition-colors ${on ? "border-brand bg-brand text-brand-foreground" : "border-border bg-background hover:border-primary/40"}`}><Icon className="size-4" />{f.label}</button>;
                        })}
                      </div>
                      {fields.length === 0 ? <p role="alert" className="flex items-center gap-1.5 text-sm font-semibold text-destructive"><IconAlertCircle className="size-4" />{PLACEMENT_LABEL[kind]}至少要有一個收件欄位，不然學生沒東西可交。純公告請改選「公告」類型。</p> : null}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">這是{PLACEMENT_LABEL[kind]}，不收資料；要改成收件請回第一步換類型。</p>
                  )}
                </>
              ) : (
                <>
                  <ul className="divide-y divide-border rounded-xl border border-border text-sm" aria-label="發布前檢查">
                    {checks.map((c) => (
                      <li key={c.key} className={`flex min-h-11 items-center gap-3 px-4 py-2 ${c.ok ? "" : "bg-destructive-subtle/40"}`}>
                        <span className={`inline-flex size-5 shrink-0 items-center justify-center rounded-full ${c.ok ? "bg-success text-success-foreground" : "bg-destructive text-white"}`}>{c.ok ? <IconCheck className="size-3" strokeWidth={3} /> : <IconAlertCircle className="size-3.5" />}</span>
                        <span className="w-16 shrink-0 text-muted-foreground">{c.label}</span>
                        <span className={`min-w-0 flex-1 truncate font-semibold ${c.ok ? "" : "text-destructive"}`}>{c.ok ? c.value : c.fix}</span>
                        {!c.ok ? <button type="button" onClick={() => setStep(c.step)} className="shrink-0 text-xs font-semibold text-destructive underline-offset-2 hover:underline">回去補</button> : null}
                      </li>
                    ))}
                  </ul>
                  <div className="rounded-xl bg-muted/40 p-4 text-sm">
                    <p className="text-xs font-bold tracking-[0.06em] text-muted-foreground">{visibility === "public" ? "訪客與學生看到的樣子" : "學生看到的樣子"}</p>
                    <p className="mt-2 text-[15px] font-bold">{title || "（未命名）"}</p>
                    <p className="mt-1 whitespace-pre-line text-muted-foreground">{summary || "（沒有說明）"}</p>
                    {attachments.length ? <p className="mt-2 text-xs text-muted-foreground">附件：{attachments.join("、")}</p> : null}
                    {collects ? <p className="mt-2 text-xs text-brand">{dueAt} 23:59 截止・出現在作業區與行事曆</p> : null}
                  </div>
                </>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-border px-6 py-4">
              <button type="button" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0} className={buttonVariants({ variant: "ghost", size: "lg", className: "press rounded-lg disabled:opacity-40" })}><IconArrowLeft className="size-4" /> 上一步</button>
              <div className="flex items-center gap-3">
                {!canNext && step < 2 ? <span className="text-xs font-semibold text-destructive">{(step === 0 ? step0Missing : step1Missing).map((c) => c.fix).join("、")}</span> : null}
                {step === 2 ? <button type="button" onClick={() => finish("draft")} className={buttonVariants({ variant: "outline", size: "lg", className: "press rounded-lg" })}>存草稿</button> : null}
                {step < 2 ? (
                  <button type="button" disabled={!canNext} onClick={next} className="btn-fju h-10 rounded-lg px-5 text-sm disabled:opacity-40">下一步 <IconArrowRight className="size-4" /></button>
                ) : (
                  <button type="button" disabled={!canNext} onClick={() => finish("published")} className="btn-fju h-10 rounded-lg px-5 text-sm disabled:opacity-40">{missing.length ? `還缺 ${missing.length} 項` : "發布"}</button>
                )}
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
