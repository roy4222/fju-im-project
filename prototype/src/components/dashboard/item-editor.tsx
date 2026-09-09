"use client";

import { useRef, useState } from "react";
import { IconArrowDown, IconArrowUp, IconCheck, IconCopy, IconDeviceDesktop, IconDeviceMobile, IconEye, IconGripVertical, IconPlus, IconSend, IconTrash } from "@tabler/icons-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { buttonVariants } from "@/components/ui/button";
import { GroupForm } from "@/components/dashboard/group-form";
import { FIELD_TYPE_LABEL, PLACEMENT_LABEL, type FieldType, type FormField, type ManagedItem, type Placement } from "@/lib/fixtures";

const PALETTE: { group: string; types: FieldType[] }[] = [
  { group: "內容", types: ["heading", "paragraph", "divider", "attachment", "groupinfo"] },
  { group: "填寫", types: ["text", "textarea", "number", "email", "url"] },
  { group: "選擇", types: ["radio", "checkbox", "select"] },
  { group: "日期與檔案", types: ["date", "time", "file"] },
];

const AUDIENCES = ["公開訪客", "所有已登入使用者", "本屆學生", "全部老師", "指定組別"];

/**
 * 專題事務編輯器（規格 §4.4，簡化版，Roy 2026-09-08）：
 * 上：標題、發布位置、對象、狀態、預覽、發布。左：可加入的區塊。中：欄位清單可排序。右：選取欄位的設定。
 * 已有回覆後改結構會建立新版本（§4.5）。
 */
export function ItemEditor({ item, initialFields, hasResponses }: { item: Partial<ManagedItem>; initialFields: FormField[]; hasResponses: boolean }) {
  const [title, setTitle] = useState(item.title ?? "");
  const [summary, setSummary] = useState(item.summary ?? "");
  const [placement, setPlacement] = useState<Placement>(item.placement ?? "submission");
  const [audience, setAudience] = useState(item.audience && AUDIENCES.includes(item.audience) ? item.audience : "本屆學生");
  const [dueAt, setDueAt] = useState(item.dueAt ?? "");
  const [fields, setFields] = useState<FormField[]>(initialFields);
  const [selected, setSelected] = useState<string | null>(initialFields[0]?.id ?? null);
  const [preview, setPreview] = useState<null | "desktop" | "mobile">(null);
  const [published, setPublished] = useState(false);
  const [structureChanged, setStructureChanged] = useState(false);
  const collects = placement === "submission" || placement === "requirement";
  const seq = useRef(0);
  const nextId = () => `fn${++seq.current}`;

  const sel = fields.find((f) => f.id === selected) ?? null;

  function add(type: FieldType) {
    const id = nextId();
    const f: FormField = { id, type, label: FIELD_TYPE_LABEL[type], ...(type === "radio" || type === "checkbox" || type === "select" ? { options: ["選項 1", "選項 2"] } : {}) };
    setFields((xs) => [...xs, f]);
    setSelected(id);
    setStructureChanged(true);
  }
  function update(patch: Partial<FormField>) {
    if (!sel) return;
    setFields((xs) => xs.map((f) => (f.id === sel.id ? { ...f, ...patch } : f)));
    if ("type" in patch || "options" in patch) setStructureChanged(true);
  }
  function move(id: string, d: -1 | 1) {
    setFields((xs) => {
      const i = xs.findIndex((f) => f.id === id);
      const j = i + d;
      if (i < 0 || j < 0 || j >= xs.length) return xs;
      const c = [...xs];
      [c[i], c[j]] = [c[j], c[i]];
      return c;
    });
    setStructureChanged(true);
  }
  function remove(id: string) {
    setFields((xs) => xs.filter((f) => f.id !== id));
    if (selected === id) setSelected(null);
    setStructureChanged(true);
  }
  function duplicate(id: string) {
    setFields((xs) => {
      const i = xs.findIndex((f) => f.id === id);
      const copy = { ...xs[i], id: nextId(), label: `${xs[i].label}（複製）` };
      return [...xs.slice(0, i + 1), copy, ...xs.slice(i + 1)];
    });
  }

  const input = "h-9 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none transition-[border-color,box-shadow] focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25";

  return (
    <div className="flex flex-col gap-4">
      {/* 上方：內容與發布設定 */}
      <div className="card-in rounded-xl border border-border bg-card p-4">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">標題<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例：指導老師意願調查表" className={`${input} text-[15px] font-bold`} /></label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">主要發布位置（單選）
            <select value={placement} onChange={(e) => setPlacement(e.target.value as Placement)} className={input}>
              {(Object.keys(PLACEMENT_LABEL) as Placement[]).map((p) => <option key={p} value={p}>{PLACEMENT_LABEL[p]}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">發布對象
            <select value={audience} onChange={(e) => setAudience(e.target.value)} className={input}>{AUDIENCES.map((a) => <option key={a}>{a}</option>)}</select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">截止日{collects ? "" : "（選填）"}<input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} className={input} /></label>
        </div>
        <label className="mt-3 flex flex-col gap-1 text-xs font-semibold text-muted-foreground">摘要<input value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="一句話說明，會出現在列表與 Dashboard" className={input} /></label>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${published ? "bg-success-subtle text-success-on-subtle" : "bg-muted text-muted-foreground"}`}>{published ? "發布中" : item.status === "published" ? "發布中・有未發布修改" : "草稿"}</span>
          {hasResponses ? <span className="rounded-full bg-warning-subtle px-2.5 py-1 text-xs font-semibold text-warning-on-subtle">已有 {item.progress?.done ?? 0} 組回覆</span> : null}
          {hasResponses && structureChanged ? <span className="rounded-full bg-info-subtle px-2.5 py-1 text-xs font-semibold text-info-on-subtle">結構已變更 → 發布時建立 v{(item.schemaVersion ?? 1) + 1}</span> : null}
          <div className="ml-auto flex gap-2">
            <button type="button" onClick={() => setPreview("desktop")} className={buttonVariants({ variant: "outline", size: "lg", className: "press rounded-lg" })}><IconEye /> 預覽</button>
            <button type="button" onClick={() => setPublished(true)} className="btn-fju h-9 px-4 text-sm"><IconSend className="size-4" /> {item.status === "published" ? "發布更新" : "發布"}</button>
          </div>
        </div>
      </div>

      {/* 三欄 */}
      <div className="grid items-start gap-4 lg:grid-cols-[13rem_minmax(0,1fr)_18rem]">
        <aside className="card-in rounded-xl border border-border bg-card p-3">
          <p className="px-1 pb-2 text-xs font-bold text-muted-foreground">加入區塊</p>
          {PALETTE.map((p) => (
            <div key={p.group} className="mb-2">
              <p className="px-1 py-1 text-[11px] font-semibold tracking-wider text-muted-foreground/80">{p.group}</p>
              <ul className="flex flex-col gap-0.5">
                {p.types.map((t) => (
                  <li key={t}>
                    <button type="button" onClick={() => add(t)} className="press flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] font-medium transition-colors hover:bg-brand-subtle hover:text-brand-on-subtle">
                      <IconPlus className="size-3.5 text-muted-foreground" /> {FIELD_TYPE_LABEL[t]}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </aside>

        <section className="card-in min-h-[420px] rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <p className="text-sm font-bold">欄位（{fields.length}）</p>
            <p className="text-xs text-muted-foreground">點選編輯，上下鍵排序</p>
          </div>
          {fields.length === 0 ? (
            <div className="flex min-h-[320px] flex-col items-center justify-center gap-2 text-center">
              <p className="text-sm font-semibold">從左側加入第一個區塊</p>
              <p className="text-xs text-muted-foreground">公告只需說明文字與附件；收件項目再加填寫欄位。</p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2 p-3">
              {fields.map((f, i) => (
                <li key={f.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelected(f.id)}
                    onKeyDown={(e) => e.key === "Enter" && setSelected(f.id)}
                    className={`group flex items-center gap-2 rounded-lg border px-3 py-2.5 transition-[border-color,background-color,box-shadow] ${selected === f.id ? "border-brand bg-brand-subtle/40 shadow-[0_0_0_3px_color-mix(in_oklch,var(--brand)_18%,transparent)]" : "border-border bg-background hover:border-primary/40"}`}
                  >
                    <IconGripVertical className="size-4 shrink-0 text-muted-foreground/60" />
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">{FIELD_TYPE_LABEL[f.type]}</span>
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold">{f.label}</span>
                    {f.required ? <span className="text-[11px] font-semibold text-destructive">必填</span> : null}
                    <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                      <button type="button" onClick={(e) => { e.stopPropagation(); move(f.id, -1); }} disabled={i === 0} className="inline-flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30" aria-label="上移"><IconArrowUp className="size-4" /></button>
                      <button type="button" onClick={(e) => { e.stopPropagation(); move(f.id, 1); }} disabled={i === fields.length - 1} className="inline-flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30" aria-label="下移"><IconArrowDown className="size-4" /></button>
                      <button type="button" onClick={(e) => { e.stopPropagation(); duplicate(f.id); }} className="inline-flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="複製"><IconCopy className="size-4" /></button>
                      <button type="button" onClick={(e) => { e.stopPropagation(); remove(f.id); }} className="inline-flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-destructive-subtle hover:text-destructive" aria-label="刪除"><IconTrash className="size-4" /></button>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside className="card-in rounded-xl border border-border bg-card p-4">
          <p className="pb-3 text-xs font-bold text-muted-foreground">設定</p>
          {!sel ? (
            <p className="text-sm text-muted-foreground">選一個欄位來編輯。</p>
          ) : (
            <div className="flex flex-col gap-3">
              <span className="w-fit rounded bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">{FIELD_TYPE_LABEL[sel.type]}</span>
              <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">{sel.type === "paragraph" ? "內容" : "標籤"}
                {sel.type === "paragraph" ? <textarea rows={4} value={sel.label} onChange={(e) => update({ label: e.target.value })} className={`${input} h-auto py-2`} /> : <input value={sel.label} onChange={(e) => update({ label: e.target.value })} className={input} />}
              </label>
              {!["heading", "paragraph", "divider", "groupinfo", "attachment"].includes(sel.type) ? (
                <>
                  <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">說明<input value={sel.help ?? ""} onChange={(e) => update({ help: e.target.value })} className={input} /></label>
                  <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={!!sel.required} onChange={(e) => update({ required: e.target.checked })} className="size-4 accent-[var(--brand)]" /> 必填</label>
                </>
              ) : null}
              {["text", "textarea", "number", "email", "url"].includes(sel.type) ? (
                <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">提示文字<input value={sel.placeholder ?? ""} onChange={(e) => update({ placeholder: e.target.value })} className={input} /></label>
              ) : null}
              {sel.options ? (
                <div className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">選項（一行一個）
                  <textarea rows={4} value={sel.options.join("\n")} onChange={(e) => update({ options: e.target.value.split("\n") })} className={`${input} h-auto py-2 font-normal`} />
                </div>
              ) : null}
              {sel.type === "file" || sel.type === "attachment" ? (
                <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">{sel.type === "file" ? "限制" : "檔案"}<input value={sel.meta ?? ""} onChange={(e) => update({ meta: e.target.value })} placeholder={sel.type === "file" ? "PDF・上限 100 MiB" : "檔名・大小"} className={input} /></label>
              ) : null}
              <button type="button" onClick={() => remove(sel.id)} className={buttonVariants({ variant: "destructive", size: "lg", className: "press mt-2 rounded-lg" })}><IconTrash /> 刪除欄位</button>
            </div>
          )}
        </aside>
      </div>

      {/* 預覽 */}
      <Dialog open={preview !== null} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="max-w-[calc(100%-2rem)] p-0 sm:max-w-4xl" showCloseButton>
          <div className="flex items-center gap-2 border-b border-border px-5 py-3">
            <DialogTitle className="text-base font-bold">預覽・學生視角</DialogTitle>
            <div className="ml-auto flex gap-1 rounded-lg bg-muted p-0.5">
              <button type="button" onClick={() => setPreview("desktop")} className={`inline-flex size-8 items-center justify-center rounded-md ${preview === "desktop" ? "bg-background shadow-sm" : "text-muted-foreground"}`} aria-label="桌機"><IconDeviceDesktop className="size-4" /></button>
              <button type="button" onClick={() => setPreview("mobile")} className={`inline-flex size-8 items-center justify-center rounded-md ${preview === "mobile" ? "bg-background shadow-sm" : "text-muted-foreground"}`} aria-label="手機"><IconDeviceMobile className="size-4" /></button>
            </div>
          </div>
          <div className="max-h-[70vh] overflow-y-auto bg-muted/40 p-5">
            <div className={`mx-auto rounded-xl border border-border bg-background p-5 transition-[max-width] duration-300 ${preview === "mobile" ? "max-w-[390px]" : "max-w-3xl"}`}>
              <h2 className="text-lg font-extrabold">{title || "（未命名）"}</h2>
              <p className="mt-1 mb-4 text-sm text-muted-foreground">{summary}</p>
              <GroupForm fields={fields} state="todo" locked={false} backHref="#" itemTitle={title} />
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={published} onOpenChange={setPublished}>
        <DialogContent className="max-w-md">
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="inline-flex size-14 items-center justify-center rounded-full bg-success-subtle text-success-on-subtle"><IconCheck className="size-7" /></span>
            <DialogTitle className="text-xl font-extrabold">已發布</DialogTitle>
            <DialogDescription className="text-sm">{title || "（未命名）"}</DialogDescription>
            <dl className="mt-1 grid w-full grid-cols-2 gap-x-4 gap-y-1.5 rounded-lg bg-muted px-4 py-3 text-left text-sm">
              <dt className="text-muted-foreground">位置</dt><dd className="font-semibold">{PLACEMENT_LABEL[placement]}</dd>
              <dt className="text-muted-foreground">對象</dt><dd className="font-semibold">{audience}</dd>
              <dt className="text-muted-foreground">截止</dt><dd className="tabular font-semibold">{dueAt || "無"}</dd>
              <dt className="text-muted-foreground">欄位版本</dt><dd className="tabular font-semibold">v{hasResponses && structureChanged ? (item.schemaVersion ?? 1) + 1 : (item.schemaVersion ?? 1)}</dd>
            </dl>
            <p className="text-xs text-muted-foreground">Dashboard 待辦與首頁摘要會自動引用，不需另外複製。</p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
