"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { IconAlertCircle, IconArrowDown, IconArrowLeft, IconArrowUp, IconBold, IconCheck, IconCopy, IconDeviceDesktop, IconDeviceMobile, IconEye, IconLink, IconList, IconPaperclip, IconPhoto, IconPlus, IconSend, IconTrash, IconX } from "@tabler/icons-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { buttonVariants } from "@/components/ui/button";
import { PageTitle } from "@/components/dashboard/primitives";
import { GroupPicker } from "@/components/dashboard/group-picker";
import { AUDIENCES, audienceText } from "@/components/dashboard/new-item-dialog";
import { FIELD_TYPE_LABEL, GROUPS, MY_GROUP, PLACEMENT_LABEL, type FieldType, type FormField, type Placement } from "@/lib/fixtures";
import { describeGroups, emptyDraft, isDraftId, newDraftId, readDraftsRaw, saveDraft, subscribeDrafts, type Draft, type Visibility } from "@/lib/draft-store";

/**
 * 內容編輯器（Codex 09-10 A-03 重做）：一頁一件事、由上往下——
 * 頂列固定（標題／儲存狀態／存草稿／預覽／發布）→ 1 內容 → 2 收件欄位 → 3 發布設定 → 4 預覽確認。
 * 整個編輯器是一張 dash-card，段落用 1px 線分隔；手機（<1024px）四段變分頁、欄位設定用底部抽屜。
 * 已有回覆後改結構會在發布時建立新版本（§4.5）。
 */
export type EditorMeta = { base: string; schemaVersion: number; hasResponses: boolean; responses: number; isNew: boolean };

const ADD_TYPES: FieldType[] = ["text", "textarea", "radio", "checkbox", "select", "date", "file", "heading", "paragraph", "groupinfo"];
const STATIC_TYPES: FieldType[] = ["heading", "paragraph", "divider", "groupinfo", "attachment"];
const INPUT_TYPES: FieldType[] = ["text", "textarea", "number", "email", "url", "radio", "checkbox", "select", "date", "time", "file"];
const input = "h-10 w-full rounded-lg border border-input bg-background px-3 text-sm font-normal outline-none transition-[border-color,box-shadow] focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25";
const SECTIONS = [
  { key: "content", label: "內容" },
  { key: "fields", label: "欄位" },
  { key: "publish", label: "發布" },
  { key: "preview", label: "預覽" },
] as const;
type SectionKey = (typeof SECTIONS)[number]["key"];

function useDesktop() {
  const [desktop, setDesktop] = useState(true);
  useEffect(() => {
    const mql = window.matchMedia("(min-width: 1024px)");
    const on = () => setDesktop(mql.matches);
    on();
    mql.addEventListener("change", on);
    return () => mql.removeEventListener("change", on);
  }, []);
  return desktop;
}

/* ------------------------------------------------------------------ 載入草稿 */
/** 依 id 從 sessionStorage 讀草稿；`new` 就建一個新 id 再導過去；已發布項目先看有沒有本地修改，沒有就用 fixtures 轉的初始值。 */
export function DraftEditor({ id, base, fallback, meta }: { id: string; base: string; fallback?: Draft; meta: Omit<EditorMeta, "base" | "isNew"> }) {
  const router = useRouter();
  const raw = useSyncExternalStore(subscribeDrafts, readDraftsRaw, () => null);
  const draft = useMemo<Draft | null | "missing">(() => {
    if (raw === null || id === "new") return null;
    const stored = raw ? (JSON.parse(raw) as Record<string, Draft>)[id] : undefined;
    return stored ?? fallback ?? "missing";
  }, [raw, id, fallback]);
  useEffect(() => {
    if (id !== "new") return;
    const nid = newDraftId();
    saveDraft(emptyDraft(nid));
    router.replace(`${base}/editor/${nid}`);
  }, [id, base, router]);
  if (draft === "missing") {
    return (
      <div className="flex flex-col gap-4">
        <Link href={`${base}/affairs`} className="inline-flex w-fit items-center gap-1 text-[13px] font-semibold text-muted-foreground transition-colors hover:text-foreground"><IconArrowLeft className="size-4" /> 專題事務</Link>
        <PageTitle title="找不到這份草稿" description="草稿只存在這個瀏覽器分頁（原型用 sessionStorage）；關掉分頁就沒了。" actions={<Link href={`${base}/editor/new`} className="btn-fju h-10 px-4 text-sm">開新草稿</Link>} />
      </div>
    );
  }
  if (!draft) return <div className="min-h-[50vh]" aria-busy="true" />;
  return <ItemEditor key={draft.id} initial={draft} meta={{ ...meta, base, isNew: isDraftId(draft.id) }} />;
}

/* ------------------------------------------------------------------ 編輯器 */
export function ItemEditor({ initial, meta }: { initial: Draft; meta: EditorMeta }) {
  const desktop = useDesktop();
  const [d, setD] = useState<Draft>(initial);
  const [savedAt, setSavedAt] = useState<string | null>(initial.updatedAt);
  const [dirty, setDirty] = useState(false);
  const [structureChanged, setStructureChanged] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [tab, setTab] = useState<SectionKey>("content");
  const [preview, setPreview] = useState<null | { device: "desktop" | "mobile"; as: "guest" | "student" | "teacher" }>(null);
  const [publishStep, setPublishStep] = useState<null | "check" | "done">(null);
  const seq = useRef(initial.fields.length);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const collects = d.kind === "submission" || d.kind === "requirement";
  const needsGroups = d.audience === "指定組別";
  const nextVersion = meta.hasResponses && structureChanged ? meta.schemaVersion + 1 : meta.schemaVersion;

  const patch = useCallback((p: Partial<Draft>) => { setD((x) => ({ ...x, ...p })); setDirty(true); }, []);
  function save(status?: Draft["status"]) {
    const saved = saveDraft({ ...d, ...(status ? { status } : {}), ...(status === "published" ? { publishedAt: d.publishedAt ?? d.updatedAt } : {}) });
    setD(saved);
    setSavedAt(saved.updatedAt);
    setDirty(false);
  }
  /* 停手 2 秒自動存（只有草稿狀態；已發布項目要手動存，避免誤以為改了就上線） */
  useEffect(() => {
    if (!dirty || d.status === "published") return;
    const t = setTimeout(() => save(), 2000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, dirty]);

  /* 欄位操作 */
  const nextId = () => `fn${++seq.current}`;
  function addField(type: FieldType) {
    const id = nextId();
    const f: FormField = { id, type, label: type === "paragraph" ? "" : FIELD_TYPE_LABEL[type], ...(["radio", "checkbox", "select"].includes(type) ? { options: ["選項 1", "選項 2"] } : {}), ...(type === "file" ? { meta: "PDF・上限 100 MiB" } : {}) };
    patch({ fields: [...d.fields, f] });
    setEditing(id);
    setStructureChanged(true);
  }
  function updateField(id: string, p: Partial<FormField>) {
    patch({ fields: d.fields.map((f) => (f.id === id ? { ...f, ...p } : f)) });
    if ("type" in p || "options" in p || "required" in p) setStructureChanged(true);
  }
  function moveField(id: string, dir: -1 | 1) {
    const i = d.fields.findIndex((f) => f.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= d.fields.length) return;
    const c = [...d.fields];
    [c[i], c[j]] = [c[j], c[i]];
    patch({ fields: c });
    setStructureChanged(true);
  }
  function removeField(id: string) {
    patch({ fields: d.fields.filter((f) => f.id !== id) });
    if (editing === id) setEditing(null);
    setStructureChanged(true);
  }
  function duplicateField(id: string) {
    const i = d.fields.findIndex((f) => f.id === id);
    const copy = { ...d.fields[i], id: nextId(), label: `${d.fields[i].label}（複製）` };
    patch({ fields: [...d.fields.slice(0, i + 1), copy, ...d.fields.slice(i + 1)] });
    setStructureChanged(true);
  }
  /* 正文工具列：在游標處插 Markdown 標記（原型不裝編輯器套件） */
  function insert(before: string, after = "", placeholder = "") {
    const el = bodyRef.current;
    const start = el?.selectionStart ?? d.body.length;
    const end = el?.selectionEnd ?? d.body.length;
    const mid = d.body.slice(start, end) || placeholder;
    const next = d.body.slice(0, start) + before + mid + after + d.body.slice(end);
    patch({ body: next });
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(start + before.length, start + before.length + mid.length); });
  }

  /* 發布檢查 */
  const inputCount = d.fields.filter((f) => INPUT_TYPES.includes(f.type)).length;
  const checks = [
    { key: "title", label: "標題", ok: d.title.trim().length > 0, value: d.title.trim(), fix: "填標題", section: "content" as SectionKey },
    { key: "audience", label: "對象", ok: !needsGroups || d.groupIds.length > 0, value: audienceText(d.audience, d.groupIds), fix: "至少選一組", section: "publish" as SectionKey },
    { key: "due", label: "截止", ok: !collects || !!d.dueAt, value: d.dueAt || "不設截止", fix: "收件類要有截止日", section: "publish" as SectionKey },
    { key: "fields", label: "欄位", ok: !collects || inputCount > 0, value: collects ? `${inputCount} 個收件欄位` : "不收資料", fix: "至少一個收件欄位", section: "fields" as SectionKey },
    { key: "vis", label: "公開範圍", ok: true, value: d.visibility === "public" ? "網際網路公開" : "登入後學生可見", fix: "", section: "publish" as SectionKey },
  ];
  const missing = checks.filter((c) => !c.ok);
  const notifyLine = useMemo(() => {
    if (!d.notify) return "不通知";
    if (needsGroups) { const g = describeGroups(d.groupIds, GROUPS); return g.count ? `${g.text}，${g.students} 人` : "還沒選組別"; }
    if (d.audience === "本屆學生") return `本屆 ${GROUPS.length} 組，${GROUPS.reduce((a, g) => a + g.members.length, 0)} 人`;
    if (d.audience === "全部老師") return "全部老師，4 人";
    if (d.audience === "公開訪客") return "不寄信（公開內容不通知）";
    return "所有已登入使用者";
  }, [d.notify, d.audience, d.groupIds, needsGroups]);

  function publish() {
    save("published");
    setPublishStep("done");
  }

  const editingField = d.fields.find((f) => f.id === editing) ?? null;
  const show = (k: SectionKey) => desktop || tab === k;
  const sectionHead = (n: number, title: string, hint?: string, right?: React.ReactNode) => (
    <div className="flex items-center gap-3 px-5 pt-5 pb-3 lg:px-6">
      <span className="tabular inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-bold">{n}</span>
      <h2 className="text-[15px] font-bold">{title}</h2>
      {hint ? <span className="hidden truncate text-xs text-muted-foreground sm:inline">・{hint}</span> : null}
      {right ? <div className="ml-auto">{right}</div> : null}
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <Link href={`${meta.base}/affairs`} className="inline-flex w-fit items-center gap-1 text-[13px] font-semibold text-muted-foreground transition-colors hover:text-foreground"><IconArrowLeft className="size-4" /> 專題事務</Link>

      <div className="dash-card overflow-clip">
        {/* 頂列：標題｜儲存狀態｜存草稿｜預覽｜發布 */}
        <div className="sticky top-14 z-20 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-card px-5 py-3 lg:px-6">
          <label className="sr-only" htmlFor="ed-title">標題</label>
          <input id="ed-title" value={d.title} onChange={(e) => patch({ title: e.target.value })} placeholder="標題" className="min-w-0 flex-1 basis-64 bg-transparent text-xl font-extrabold tracking-tight outline-none placeholder:text-muted-foreground/60" />
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
            <span aria-hidden className={`inline-block size-2 rounded-full ${dirty ? "border-[1.5px] border-foreground/70" : "bg-foreground"}`} />
            {dirty ? "未儲存" : `已儲存 ${savedAt?.slice(11) ?? ""}`}
            <span className="hidden sm:inline">・{d.status === "published" ? (dirty ? "發布中，有未發布修改" : "發布中") : "草稿"}</span>
          </span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => save()} disabled={!dirty} className={buttonVariants({ variant: "outline", size: "lg", className: "press rounded-lg disabled:opacity-50" })}>存草稿</button>
            <button type="button" onClick={() => setPreview({ device: "desktop", as: "student" })} className={buttonVariants({ variant: "outline", size: "lg", className: "press rounded-lg" })}><IconEye /> 預覽</button>
            <button type="button" onClick={() => setPublishStep("check")} className="btn-fju h-9 rounded-lg px-4 text-sm"><IconSend className="size-4" /> {d.status === "published" ? "發布更新" : "發布"}</button>
          </div>
          {meta.hasResponses && structureChanged ? <p className="basis-full text-xs font-semibold text-foreground"><IconAlertCircle className="mr-1 inline size-3.5 text-brand" />已有 {meta.responses} 組回覆；結構已變更 → 發布時建立 v{nextVersion}，舊回覆保留在 v{meta.schemaVersion}。</p> : null}
          {/* 手機：四個分頁 */}
          <nav className="-mb-3 basis-full border-t border-border lg:hidden" aria-label="編輯區段">
            <ul className="grid grid-cols-4">
              {SECTIONS.map((s) => {
                const bad = missing.some((m) => m.section === s.key);
                return (
                  <li key={s.key}>
                    <button type="button" onClick={() => setTab(s.key)} aria-current={tab === s.key ? "page" : undefined} className={`relative h-11 w-full text-sm font-semibold ${tab === s.key ? "text-foreground after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:bg-brand" : "text-muted-foreground"}`}>
                      {s.label}{bad ? <span aria-hidden className="ml-1 inline-block size-1.5 rounded-full bg-destructive align-middle" /> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
        </div>

        {/* 1 內容 */}
        {show("content") ? (
          <section id="sec-content" aria-label="內容">
            {sectionHead(1, "內容", "公告與資源的主體；學生打開先看到這段")}
            <div className="flex flex-col gap-4 px-5 pb-6 lg:px-6">
              <div className="rounded-lg border border-input focus-within:border-brand focus-within:ring-3 focus-within:ring-brand/25">
                <div className="flex items-center gap-0.5 border-b border-border px-1.5 py-1" role="toolbar" aria-label="格式">
                  <button type="button" onClick={() => insert("**", "**", "重點")} title="粗體" aria-label="粗體" className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"><IconBold className="size-4" /></button>
                  <button type="button" onClick={() => insert("\n- ", "", "項目")} title="清單" aria-label="清單" className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"><IconList className="size-4" /></button>
                  <button type="button" onClick={() => insert("[", "](https://)", "連結文字")} title="連結" aria-label="連結" className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"><IconLink className="size-4" /></button>
                  <button type="button" onClick={() => insert("\n![", "](圖片.jpg)\n", "圖片說明")} title="插入圖片" aria-label="插入圖片" className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"><IconPhoto className="size-4" /></button>
                  <button type="button" onClick={() => { const name = `附件-${d.attachments.length + 1}.pdf`; patch({ attachments: [...d.attachments, name] }); insert(`\n[附件：${name}]\n`); }} title="附件" aria-label="附件" className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"><IconPaperclip className="size-4" /></button>
                  <span className="ml-auto pr-2 text-[11px] text-muted-foreground">Markdown</span>
                </div>
                <label className="sr-only" htmlFor="ed-body">正文</label>
                <textarea id="ed-body" ref={bodyRef} rows={desktop ? 10 : 8} value={d.body} onChange={(e) => patch({ body: e.target.value })} placeholder={collects ? "要交什麼、格式、上限。學生在作業說明看到的就是這段。" : "寫公告內容。段落之間空一行；工具列可插入連結、圖片與附件。"} className="w-full resize-y bg-transparent px-4 py-3 text-[15px] leading-relaxed outline-none" />
              </div>
              <label className="flex flex-col gap-1.5 text-sm font-semibold">摘要 <span className="text-xs font-normal text-muted-foreground">一句話，列表與首頁用</span>
                <input value={d.summary} onChange={(e) => patch({ summary: e.target.value })} className={input} placeholder="例：分組名單確認表已開放填寫。" />
              </label>
              <div className="flex flex-col gap-2">
                <p className="text-sm font-semibold">附件 <span className="text-xs font-normal text-muted-foreground">{d.attachments.length ? `${d.attachments.length} 個` : "無"}</span></p>
                <ul className="flex flex-wrap gap-2">
                  {d.attachments.map((a) => (
                    <li key={a} className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-background pr-1 pl-3 text-sm font-semibold"><IconPaperclip className="size-4 text-muted-foreground" />{a}<button type="button" onClick={() => patch({ attachments: d.attachments.filter((x) => x !== a) })} aria-label={`移除 ${a}`} className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"><IconX className="size-4" /></button></li>
                  ))}
                  <li><button type="button" onClick={() => patch({ attachments: [...d.attachments, `附件-${d.attachments.length + 1}.pdf`] })} className={buttonVariants({ variant: "outline", size: "lg", className: "press rounded-lg border-dashed" })}><IconPlus /> 加附件</button></li>
                </ul>
              </div>
            </div>
          </section>
        ) : null}

        {/* 2 收件欄位 */}
        {show("fields") ? (
          <section id="sec-fields" aria-label="收件欄位" className="border-t border-border">
            {sectionHead(2, "收件欄位", collects ? `學生會看到的樣子；點一欄原地改設定・${inputCount} 個` : undefined, collects ? <AddFieldMenu onPick={addField} /> : null)}
            {!collects ? (
              <div className="flex flex-wrap items-center gap-3 px-5 pb-6 lg:px-6">
                <p className="text-sm text-muted-foreground">這個項目不收資料。</p>
                <button type="button" onClick={() => patch({ kind: "submission" })} className={buttonVariants({ variant: "outline", size: "lg", className: "press rounded-lg" })}>啟用收件（改為文件繳交）</button>
              </div>
            ) : d.fields.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-5 pb-8 text-center">
                <p className="text-sm font-semibold text-destructive">還沒有欄位，學生沒東西可交。</p>
                <AddFieldMenu onPick={addField} primary />
              </div>
            ) : (
              <ol className="flex flex-col divide-y divide-border border-t border-border">
                {d.fields.map((f, i) => {
                  const open = editing === f.id;
                  return (
                    <li key={f.id} className={`transition-colors ${open ? "bg-brand-subtle/25" : "hover:bg-accent/40"}`}>
                      <div className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-start sm:gap-3 lg:px-6">
                        <button type="button" onClick={() => setEditing(open && desktop ? null : f.id)} aria-expanded={open} className="min-w-0 flex-1 text-left" aria-label={`編輯欄位：${f.label || FIELD_TYPE_LABEL[f.type]}`}>
                          <FieldPreview field={f} />
                        </button>
                        <span className="flex shrink-0 items-center gap-0.5 self-end sm:self-start sm:pt-0.5">
                          <span className="mr-1 hidden rounded bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground sm:inline">{FIELD_TYPE_LABEL[f.type]}</span>
                          <button type="button" onClick={() => moveField(f.id, -1)} disabled={i === 0} className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30" aria-label="上移"><IconArrowUp className="size-4" /></button>
                          <button type="button" onClick={() => moveField(f.id, 1)} disabled={i === d.fields.length - 1} className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30" aria-label="下移"><IconArrowDown className="size-4" /></button>
                          <button type="button" onClick={() => duplicateField(f.id)} className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="複製"><IconCopy className="size-4" /></button>
                          <button type="button" onClick={() => removeField(f.id)} className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive-subtle hover:text-destructive" aria-label="刪除"><IconTrash className="size-4" /></button>
                        </span>
                      </div>
                      {open && desktop ? (
                        <div className="border-t border-border/70 px-5 pt-3 pb-4 lg:px-6">
                          <FieldSettings field={f} onChange={(p) => updateField(f.id, p)} onClose={() => setEditing(null)} />
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        ) : null}

        {/* 3 發布設定 */}
        {show("publish") ? (
          <section id="sec-publish" aria-label="發布設定" className="border-t border-border">
            {sectionHead(3, "發布設定", "位置、對象、公開範圍、截止、通知")}
            <div className="grid gap-4 px-5 pb-6 sm:grid-cols-2 lg:px-6">
              <label className="flex flex-col gap-1.5 text-sm font-semibold">發布位置
                <select value={d.kind} onChange={(e) => { patch({ kind: e.target.value as Placement }); }} className={input}>
                  {(["news", "resource", "submission", "requirement"] as Placement[]).map((p) => <option key={p} value={p}>{PLACEMENT_LABEL[p]}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-semibold">對象
                <select value={d.audience} onChange={(e) => { const a = e.target.value; patch({ audience: a, ...(a === "公開訪客" ? { visibility: "public" as Visibility } : {}) }); }} className={input}>{AUDIENCES.map((a) => <option key={a}>{a}</option>)}</select>
              </label>
              {needsGroups ? (
                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <p className="text-sm font-semibold">指定組別 <span className="font-normal text-muted-foreground">・{describeGroups(d.groupIds, GROUPS).text}</span></p>
                  <GroupPicker value={d.groupIds} onChange={(ids) => patch({ groupIds: ids })} id="ed-groups" />
                </div>
              ) : null}
              <fieldset className="flex flex-col gap-1.5">
                <legend className="text-sm font-semibold">公開範圍</legend>
                <div className="flex flex-wrap gap-2">
                  {([["students", "登入後學生可見"], ["public", "網際網路公開"]] as [Visibility, string][]).map(([v, l]) => (
                    <label key={v} className={`inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm font-semibold transition-colors ${d.visibility === v ? "border-brand bg-brand-subtle/40 text-brand-on-subtle" : "border-border hover:border-primary/40"}`}>
                      <input type="radio" name="ed-visibility" value={v} checked={d.visibility === v} onChange={() => patch({ visibility: v })} className="accent-[var(--brand)]" />{l}
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="flex flex-col gap-1.5 text-sm font-semibold">{collects ? "截止日" : "截止日（選填）"}<input type="date" value={d.dueAt} onChange={(e) => patch({ dueAt: e.target.value })} className={input} /></label>
              <label className="flex min-h-10 items-center gap-2 text-sm font-semibold sm:col-span-2"><input type="checkbox" checked={d.notify} onChange={(e) => patch({ notify: e.target.checked })} className="size-4 accent-[var(--brand)]" /> 發布時通知 <span className="font-normal text-muted-foreground">・{notifyLine}・正式版才寄信，原型不寄</span></label>
            </div>
          </section>
        ) : null}

        {/* 4 預覽確認 */}
        {show("preview") ? (
          <section id="sec-preview" aria-label="預覽確認" className="border-t border-border">
            {sectionHead(4, "預覽確認", "切視角與裝置，看會通知誰")}
            <div className="flex flex-col gap-3 px-5 pb-6 lg:px-6">
              <ul className="divide-y divide-border rounded-lg border border-border text-sm" aria-label="發布前檢查">
                {checks.map((c) => (
                  <li key={c.key} className={`flex min-h-10 items-center gap-3 px-4 py-1.5 ${c.ok ? "" : "bg-destructive-subtle/40"}`}>
                    <span className={`inline-flex size-4.5 shrink-0 items-center justify-center rounded-full ${c.ok ? "bg-success text-success-foreground" : "bg-destructive text-white"}`}>{c.ok ? <IconCheck className="size-3" strokeWidth={3} /> : <IconAlertCircle className="size-3" />}</span>
                    <span className="w-16 shrink-0 text-muted-foreground">{c.label}</span>
                    <span className={`min-w-0 flex-1 truncate font-semibold ${c.ok ? "" : "text-destructive"}`}>{c.ok ? c.value : c.fix}</span>
                    {!c.ok ? <button type="button" onClick={() => { setTab(c.section); document.getElementById(`sec-${c.section}`)?.scrollIntoView({ block: "start" }); }} className="shrink-0 text-xs font-semibold text-destructive underline-offset-2 hover:underline">回去補</button> : null}
                  </li>
                ))}
                <li className="flex min-h-10 items-center gap-3 px-4 py-1.5"><span className="inline-block size-4.5 shrink-0" /><span className="w-16 shrink-0 text-muted-foreground">會通知</span><span className="font-semibold">{notifyLine}</span></li>
              </ul>
              <div className="flex flex-wrap gap-2">
                {([["guest", "訪客"], ["student", "學生"], ["teacher", "老師"]] as ["guest" | "student" | "teacher", string][]).map(([as, l]) => (
                  <button key={as} type="button" onClick={() => setPreview({ device: "desktop", as })} className={buttonVariants({ variant: "outline", size: "lg", className: "press rounded-lg" })}><IconEye /> {l}視角</button>
                ))}
              </div>
            </div>
          </section>
        ) : null}
      </div>

      {/* 手機：欄位設定抽屜 */}
      {!desktop ? (
        <Sheet open={!!editingField} onOpenChange={(o) => !o && setEditing(null)}>
          <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto rounded-t-2xl p-5">
            {editingField ? (
              <>
                <SheetTitle className="mb-3 text-base font-bold">{FIELD_TYPE_LABEL[editingField.type]}</SheetTitle>
                <FieldSettings field={editingField} onChange={(p) => updateField(editingField.id, p)} onClose={() => setEditing(null)} />
              </>
            ) : null}
          </SheetContent>
        </Sheet>
      ) : null}

      {/* 預覽 dialog */}
      <Dialog open={preview !== null} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="max-w-[calc(100%-2rem)] p-0 sm:max-w-4xl" showCloseButton>
          {preview ? (
            <>
              <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3 pr-12">
                <DialogTitle className="text-base font-bold">預覽</DialogTitle>
                <div className="flex gap-1 rounded-lg bg-muted p-0.5" role="group" aria-label="視角">
                  {([["guest", "訪客"], ["student", "學生"], ["teacher", "老師"]] as ["guest" | "student" | "teacher", string][]).map(([as, l]) => (
                    <button key={as} type="button" onClick={() => setPreview({ ...preview, as })} aria-pressed={preview.as === as} className={`h-8 rounded-md px-3 text-xs font-semibold ${preview.as === as ? "bg-background shadow-sm" : "text-muted-foreground"}`}>{l}</button>
                  ))}
                </div>
                <div className="ml-auto flex gap-1 rounded-lg bg-muted p-0.5" role="group" aria-label="裝置">
                  <button type="button" onClick={() => setPreview({ ...preview, device: "desktop" })} aria-pressed={preview.device === "desktop"} className={`inline-flex size-8 items-center justify-center rounded-md ${preview.device === "desktop" ? "bg-background shadow-sm" : "text-muted-foreground"}`} aria-label="桌機"><IconDeviceDesktop className="size-4" /></button>
                  <button type="button" onClick={() => setPreview({ ...preview, device: "mobile" })} aria-pressed={preview.device === "mobile"} className={`inline-flex size-8 items-center justify-center rounded-md ${preview.device === "mobile" ? "bg-background shadow-sm" : "text-muted-foreground"}`} aria-label="手機"><IconDeviceMobile className="size-4" /></button>
                </div>
              </div>
              <div className="max-h-[70vh] overflow-y-auto bg-muted/40 p-5">
                <div className={`mx-auto rounded-xl border border-border bg-background p-5 transition-[max-width] duration-200 ${preview.device === "mobile" ? "max-w-[390px]" : "max-w-3xl"}`}>
                  {preview.as === "guest" && d.visibility !== "public" ? (
                    <div className="py-10 text-center">
                      <p className="text-sm font-bold">訪客看不到這一頁</p>
                      <p className="mt-1 text-xs text-muted-foreground">公開範圍是「登入後學生可見」；要讓訪客看到，在發布設定改成「網際網路公開」。</p>
                    </div>
                  ) : (
                    <>
                      <p className="text-xs font-semibold text-muted-foreground">{PLACEMENT_LABEL[d.kind]}{d.dueAt ? `・${d.dueAt} 23:59 截止` : ""}</p>
                      <h2 className="mt-1 text-xl font-extrabold">{d.title || "（未命名）"}</h2>
                      {d.summary ? <p className="mt-1 text-sm text-muted-foreground">{d.summary}</p> : null}
                      <div className="mt-4 whitespace-pre-line text-[15px] leading-relaxed">{d.body || <span className="text-muted-foreground">（沒有正文）</span>}</div>
                      {d.attachments.length ? <ul className="mt-4 flex flex-wrap gap-2">{d.attachments.map((a) => <li key={a} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-semibold"><IconPaperclip className="size-4 text-muted-foreground" />{a}</li>)}</ul> : null}
                      {collects && preview.as !== "guest" ? (
                        <div className="mt-6 flex flex-col gap-5 border-t border-border pt-5">
                          {d.fields.map((f) => <FieldPreview key={f.id} field={f} />)}
                          {preview.as === "student" ? <div className="flex justify-end gap-2"><span className={buttonVariants({ variant: "outline", size: "lg", className: "rounded-lg" })}>儲存草稿</span><span className="btn-fju h-9 px-4 text-sm">正式送出</span></div> : <p className="text-xs text-muted-foreground">老師視角唯讀：看各組繳交狀態，不填表。</p>}
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
                <p className="mx-auto mt-3 max-w-3xl text-center text-xs text-muted-foreground">發布時會通知：{notifyLine}</p>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* 發布：檢查 → 成功 */}
      <Dialog open={publishStep !== null} onOpenChange={(o) => !o && setPublishStep(null)}>
        <DialogContent className="max-w-md">
          {publishStep === "done" ? (
            <div className="flex flex-col items-center gap-3 text-center">
              <span className="inline-flex size-14 items-center justify-center rounded-full bg-success-subtle text-success-on-subtle"><IconCheck className="size-7" /></span>
              <DialogTitle className="text-xl font-extrabold">已發布</DialogTitle>
              <DialogDescription className="text-sm leading-relaxed">「{d.title}」已發布給{audienceText(d.audience, d.groupIds)}，出現在{PLACEMENT_LABEL[d.kind]}{collects ? `，${d.dueAt} 23:59 截止` : ""}。{meta.hasResponses && structureChanged ? `欄位結構升為 v${nextVersion}，舊回覆保留。` : ""}{d.notify && d.audience !== "公開訪客" ? "通知會在正式版寄出，原型不寄信。" : ""}</DialogDescription>
              <div className="mt-1 flex gap-2">
                <Link href={`${meta.base}/affairs`} className={buttonVariants({ variant: "outline", size: "lg", className: "press rounded-lg" })}>回列表</Link>
                <button type="button" onClick={() => setPublishStep(null)} className="btn-fju h-9 px-4 text-sm">繼續編輯</button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <DialogTitle className="text-lg font-extrabold">發布前檢查</DialogTitle>
              <ul className="divide-y divide-border rounded-lg border border-border text-sm">
                {checks.map((c) => (
                  <li key={c.key} className={`flex min-h-10 items-center gap-3 px-3 py-1.5 ${c.ok ? "" : "bg-destructive-subtle/40"}`}>
                    <span className={`inline-flex size-4.5 shrink-0 items-center justify-center rounded-full ${c.ok ? "bg-success text-success-foreground" : "bg-destructive text-white"}`}>{c.ok ? <IconCheck className="size-3" strokeWidth={3} /> : <IconAlertCircle className="size-3" />}</span>
                    <span className="w-16 shrink-0 text-muted-foreground">{c.label}</span>
                    <span className={`min-w-0 flex-1 truncate font-semibold ${c.ok ? "" : "text-destructive"}`}>{c.ok ? c.value : c.fix}</span>
                    {!c.ok ? <button type="button" onClick={() => { setPublishStep(null); setTab(c.section); }} className="shrink-0 text-xs font-semibold text-destructive underline-offset-2 hover:underline">回去補</button> : null}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">會通知：{notifyLine}。{meta.hasResponses && structureChanged ? `結構已變更，發布後建立 v${nextVersion}。` : ""}</p>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setPublishStep(null)} className={buttonVariants({ variant: "outline", size: "lg", className: "press rounded-lg" })}>取消</button>
                <button type="button" disabled={missing.length > 0} onClick={publish} className="btn-fju h-9 px-4 text-sm disabled:opacity-40">{missing.length ? `還缺 ${missing.length} 項` : "確認發布"}</button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------------ 新增欄位選單 */
function AddFieldMenu({ onPick, primary }: { onPick: (t: FieldType) => void; primary?: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={primary ? <button type="button" className="btn-fju h-10 rounded-lg px-4 text-sm" /> : <button type="button" className={buttonVariants({ variant: "outline", size: "lg", className: "press rounded-lg" })} />}>
        <IconPlus className="size-4" /> 新增欄位
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {ADD_TYPES.map((t) => <DropdownMenuItem key={t} onClick={() => onPick(t)} className="min-h-9">{FIELD_TYPE_LABEL[t]}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ------------------------------------------------------------------ 欄位設定（原地展開／手機抽屜） */
function FieldSettings({ field: f, onChange, onClose }: { field: FormField; onChange: (p: Partial<FormField>) => void; onClose: () => void }) {
  const isStatic = STATIC_TYPES.includes(f.type);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground sm:col-span-2">{f.type === "paragraph" ? "內容" : "標籤"}
        {f.type === "paragraph" ? <textarea rows={3} value={f.label} onChange={(e) => onChange({ label: e.target.value })} className={`${input} h-auto py-2`} /> : <input value={f.label} onChange={(e) => onChange({ label: e.target.value })} className={input} />}
      </label>
      {!isStatic ? (
        <>
          <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">說明<input value={f.help ?? ""} onChange={(e) => onChange({ help: e.target.value })} placeholder="例：100 字內" className={input} /></label>
          {["text", "textarea", "number", "email", "url"].includes(f.type) ? <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">提示文字<input value={f.placeholder ?? ""} onChange={(e) => onChange({ placeholder: e.target.value })} className={input} /></label> : null}
          {f.type === "file" ? <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">限制<input value={f.meta ?? ""} onChange={(e) => onChange({ meta: e.target.value })} placeholder="PDF・上限 100 MiB" className={input} /></label> : null}
          {f.options ? <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground sm:col-span-2">選項（一行一個）<textarea rows={3} value={f.options.join("\n")} onChange={(e) => onChange({ options: e.target.value.split("\n") })} className={`${input} h-auto py-2`} /></label> : null}
          <label className="flex min-h-10 items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={!!f.required} onChange={(e) => onChange({ required: e.target.checked })} className="size-4 accent-[var(--brand)]" /> 必填</label>
        </>
      ) : f.type === "attachment" ? (
        <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">檔案<input value={f.meta ?? ""} onChange={(e) => onChange({ meta: e.target.value })} placeholder="檔名・大小" className={input} /></label>
      ) : null}
      <div className="flex justify-end sm:col-span-2"><button type="button" onClick={onClose} className={buttonVariants({ variant: "outline", size: "lg", className: "press rounded-lg" })}>完成</button></div>
    </div>
  );
}

/* ------------------------------------------------------------------ 欄位預覽：學生會看到的樣子（唯讀） */
export function FieldPreview({ field: f }: { field: FormField }) {
  const box = "h-10 w-full rounded-lg border border-input bg-muted/40 px-3 text-sm text-muted-foreground";
  const label = f.type === "heading" || f.type === "paragraph" || f.type === "divider" ? null : (
    <p className="text-sm font-semibold">{f.label || <span className="text-muted-foreground">（未命名欄位）</span>}{f.required ? <span className="ml-1 text-destructive" aria-label="必填">*</span> : null}{f.help ? <span className="ml-2 text-xs font-normal text-muted-foreground">{f.help}</span> : null}</p>
  );
  switch (f.type) {
    case "heading": return <h3 className="text-base font-bold">{f.label || "區段標題"}</h3>;
    case "paragraph": return <p className="text-sm leading-relaxed text-muted-foreground">{f.label || "說明文字"}</p>;
    case "divider": return <hr className="border-border" />;
    case "groupinfo": return (
      <div className="flex flex-col gap-1.5">{label}<div className="rounded-lg bg-muted/60 px-3 py-2 text-sm"><span className="font-semibold">{MY_GROUP.no}</span> <span className="text-muted-foreground">{MY_GROUP.title}・{MY_GROUP.members.map((m) => m.name).join("、")}</span></div></div>
    );
    case "attachment": return <div className="flex flex-col gap-1.5">{label}<span className="inline-flex h-9 w-fit items-center gap-2 rounded-lg border border-border px-3 text-sm font-semibold"><IconPaperclip className="size-4 text-muted-foreground" />{f.meta || "檔案"}</span></div>;
    case "textarea": return <div className="flex flex-col gap-1.5">{label}<div className={`${box} flex h-20 items-start py-2`}>{f.placeholder}</div></div>;
    case "radio":
    case "checkbox": return (
      <div className="flex flex-col gap-1.5">{label}<div className="flex flex-wrap gap-x-5 gap-y-1.5">{(f.options ?? []).map((o, i) => <span key={i} className="inline-flex items-center gap-2 text-sm"><span className={`inline-block size-4 border border-input ${f.type === "radio" ? "rounded-full" : "rounded"}`} />{o || "（空白選項）"}</span>)}</div></div>
    );
    case "select": return <div className="flex flex-col gap-1.5">{label}<div className={`${box} flex items-center justify-between`}>{f.placeholder || "請選擇"}<span className="text-xs">▾</span></div></div>;
    case "file": return <div className="flex flex-col gap-1.5">{label}<div className="flex h-14 items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted-foreground">拖放或點擊上傳・{f.meta || "不限"}</div></div>;
    case "date": return <div className="flex flex-col gap-1.5">{label}<div className={`${box} flex items-center`}>YYYY-MM-DD</div></div>;
    default: return <div className="flex flex-col gap-1.5">{label}<div className={`${box} flex items-center`}>{f.placeholder}</div></div>;
  }
}
