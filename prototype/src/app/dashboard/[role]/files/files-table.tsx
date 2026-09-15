"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { IconCheck, IconFile, IconFileText, IconFolders, IconPhoto, IconPresentation, IconDownload, IconTrash, IconUpload } from "@tabler/icons-react";
import { DataTable } from "@/components/data-table/data-table";
import { PageTitle, Panel, Pill } from "@/components/dashboard/primitives";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { buttonVariants } from "@/components/ui/button";
import { MANAGED_ITEMS, TODAY_YMD, type Role } from "@/lib/fixtures";

export type FileRow = { id: string; name: string; category: string; size: string; date: string; cohort: string; kind: string; uploader: string; refs: number; refItemId?: string };
const KIND_LABEL: Record<string, string> = { public: "公開資源", attachment: "公告附件", submission: "組別繳交" };

function icon(n: string) {
  if (n.endsWith(".pdf")) return <IconFileText className="size-4 text-muted-foreground" />;
  if (n.endsWith(".pptx")) return <IconPresentation className="size-4 text-muted-foreground" />;
  if (/\.(jpg|png)$/.test(n)) return <IconPhoto className="size-4 text-muted-foreground" />;
  return <IconFile className="size-4 text-muted-foreground" />;
}

/**
 * 檔案管理（client）：上傳 dialog 新增列、刪除受引用限制並告訴你去哪解除、引用數可點到引用的事務。
 * Codex 09-10 A-04／A-06。原型：上傳只加一列，不真的傳檔。
 */
export function FilesManager({ role, rows: initialRows, initialKind, storage }: { role: Role; rows: FileRow[]; initialKind?: string; storage: { used: number; total: number; lastBackupAt: string } }) {
  const base = `/dashboard/${role}`;
  const [rows, setRows] = useState<FileRow[]>(initialRows);
  const [removed, setRemoved] = useState<string | null>(null);
  const itemTitle = (id?: string) => MANAGED_ITEMS.find((i) => i.id === id)?.title;
  const columns: ColumnDef<FileRow, unknown>[] = useMemo(() => [
    { accessorKey: "name", meta: { label: "檔名", width: "260px" }, header: "檔名", cell: ({ row }) => <span className="flex items-center gap-2 font-semibold">{icon(row.original.name)}<span className="truncate">{row.original.name}</span></span> },
    { accessorKey: "kind", meta: { label: "類型", width: "110px" }, header: "類型", filterFn: (row, id, v: string[]) => v.includes(String(row.getValue(id))), cell: ({ row }) => <Pill tone={row.original.kind === "submission" ? "brand" : "default"}>{KIND_LABEL[row.original.kind]}</Pill> },
    { accessorKey: "category", meta: { label: "引用位置", width: "180px" }, header: "引用位置", cell: ({ row }) => row.original.refItemId ? <Link href={`${base}/affairs/${row.original.refItemId}`} className="block truncate text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">{row.original.category}</Link> : <span className="block truncate text-sm text-muted-foreground">{row.original.category}</span> },
    { accessorKey: "uploader", meta: { label: "上傳者", width: "90px" }, header: "上傳者", cell: ({ row }) => <span className="text-sm">{row.original.uploader}</span> },
    { accessorKey: "size", meta: { label: "大小", width: "90px" }, header: "大小", cell: ({ row }) => <span className="tabular text-sm text-muted-foreground">{row.original.size}</span> },
    { accessorKey: "date", meta: { label: "日期", width: "110px" }, header: "日期", cell: ({ row }) => <span className="tabular text-sm text-muted-foreground">{row.original.date}</span> },
    { accessorKey: "refs", meta: { label: "引用", width: "70px" }, header: "引用", cell: ({ row }) => row.original.refs > 0 && row.original.refItemId ? <Link href={`${base}/affairs/${row.original.refItemId}`} className="tabular text-sm font-semibold underline-offset-2 hover:underline">{row.original.refs}</Link> : <span className="tabular text-sm text-muted-foreground">{row.original.refs}</span> },
    {
      id: "actions", meta: { label: "操作", width: "200px" }, enableSorting: false, enableHiding: false, header: "操作",
      cell: ({ row }) => {
        const f = row.original;
        const locked = f.refs > 0;
        const reason = locked ? `被「${itemTitle(f.refItemId) ?? f.category}」引用，先在該項目移除附件` : undefined;
        return (
          <span className="flex items-center gap-1">
            <button type="button" disabled title="尚未提供" className={buttonVariants({ size: "sm", variant: "ghost", className: "press rounded-lg" })} aria-label="下載（尚未提供）"><IconDownload /></button>
            <button type="button" disabled={locked} title={reason} aria-describedby={locked ? `del-${f.id}` : undefined} onClick={() => { setRows((xs) => xs.filter((x) => x.id !== f.id)); setRemoved(f.name); }} className={buttonVariants({ size: "sm", variant: "ghost", className: "press rounded-lg" })} aria-label="刪除"><IconTrash /></button>
            {locked ? <span id={`del-${f.id}`} className="text-[11px] leading-tight text-muted-foreground" title={reason}>{f.refItemId ? <Link href={`${base}/editor/${f.refItemId}`} className="underline underline-offset-2 hover:text-foreground">去解除引用</Link> : "被引用"}</span> : null}
          </span>
        );
      },
    },
  ], [base]);
  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="檔案管理" description={`${rows.length} 個檔案・用量 ${storage.used}／${storage.total} GiB・最近備份 ${storage.lastBackupAt.slice(5)}・被引用的檔案不能刪`} actions={<UploadDialog onDone={(r) => setRows((xs) => [r, ...xs])} />} />
      {removed ? <p role="status" className="text-sm text-muted-foreground">已刪除「{removed}」（軟刪除，30 天內可從操作紀錄還原）。</p> : null}
      <Panel title="檔案" icon={<IconFolders />} bodyClassName="p-4">
        <DataTable
          columns={columns}
          data={rows}
          searchColumnId="name"
          searchPlaceholder="搜尋檔名"
          initialColumnFilters={initialKind && initialKind !== "all" ? [{ id: "kind", value: [initialKind] }] : undefined}
          facets={[{ columnId: "kind", label: "類型", options: Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label })) }]}
          emptyTitle="沒有檔案"
        />
      </Panel>
    </div>
  );
}

/** 上傳資源：選檔（拖放區）、權限、引用位置；完成後列表多一筆 */
function UploadDialog({ onDone }: { onDone: (r: FileRow) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [size, setSize] = useState("");
  const [visibility, setVisibility] = useState<"students" | "public">("students");
  const [ref, setRef] = useState("");
  const [done, setDone] = useState(false);
  const [drag, setDrag] = useState(false);
  const items = MANAGED_ITEMS.filter((i) => i.status !== "archived");
  function pick(file?: File) {
    if (file) { setName(file.name); setSize(file.size > 1048576 ? `${(file.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(file.size / 1024))} KB`); }
    else { setName("成果海報製作說明.pdf"); setSize("356 KB"); }
  }
  function reset() { setName(""); setSize(""); setVisibility("students"); setRef(""); setDone(false); }
  function submit() {
    const item = items.find((i) => i.id === ref);
    onDone({ id: `u-${name}-${size}`, name, category: item?.title ?? "未引用", size, date: TODAY_YMD, cohort: "114", kind: visibility === "public" ? "public" : "attachment", uploader: "系辦管理員", refs: item ? 1 : 0, refItemId: item?.id });
    setDone(true);
  }
  const field = "h-10 w-full rounded-lg border border-input bg-background px-3 text-sm font-normal outline-none focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25";
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setTimeout(reset, 200); }}>
      <DialogTrigger render={<button type="button" className="btn-fju h-10 px-4 text-sm" />}><IconUpload className="size-4" /> 上傳資源</DialogTrigger>
      <DialogContent className="max-w-md">
        {done ? (
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="inline-flex size-12 items-center justify-center rounded-full bg-success-subtle text-success-on-subtle"><IconCheck className="size-6" /></span>
            <DialogTitle className="text-lg font-extrabold">已上傳</DialogTitle>
            <DialogDescription>「{name}」已加入檔案庫（{visibility === "public" ? "公開" : "學生可見"}{ref ? `，引用於「${items.find((i) => i.id === ref)?.title}」` : "，尚未被引用"}）。原型不真的傳檔。</DialogDescription>
            <button type="button" onClick={() => setOpen(false)} className={buttonVariants({ variant: "outline", size: "lg", className: "press rounded-lg" })}>關閉</button>
          </div>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); if (name) submit(); }}>
            <DialogTitle className="text-lg font-extrabold">上傳資源</DialogTitle>
            <label
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files?.[0]); }}
              className={`flex min-h-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-dashed px-4 text-center text-sm transition-colors ${drag ? "border-brand bg-brand-subtle/40" : "border-border hover:border-brand hover:bg-brand-subtle/20"}`}
            >
              <input type="file" className="sr-only" onChange={(e) => pick(e.target.files?.[0])} />
              <IconUpload className="size-5 text-brand" />
              {name ? <span className="font-semibold">{name} <span className="tabular font-normal text-muted-foreground">{size}</span></span> : <><span className="font-semibold">拖放檔案到這裡，或點擊選檔</span><span className="text-xs text-muted-foreground">PDF、Office、圖片；單檔上限 100 MiB</span></>}
            </label>
            {!name ? <button type="button" onClick={() => pick()} className="self-start text-xs font-semibold text-muted-foreground underline-offset-2 hover:underline">原型：用一個假檔案</button> : null}
            <fieldset className="flex flex-col gap-1.5">
              <legend className="text-sm font-semibold">權限</legend>
              <div className="flex gap-2">
                {([["students", "學生可見"], ["public", "公開"]] as ["students" | "public", string][]).map(([v, l]) => (
                  <label key={v} className={`inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm font-semibold transition-colors ${visibility === v ? "border-brand bg-brand-subtle/40 text-brand-on-subtle" : "border-border hover:border-primary/40"}`}><input type="radio" name="file-vis" checked={visibility === v} onChange={() => setVisibility(v)} className="accent-[var(--brand)]" />{l}</label>
                ))}
              </div>
            </fieldset>
            <label className="flex flex-col gap-1.5 text-sm font-semibold">引用位置（選填）
              <select value={ref} onChange={(e) => setRef(e.target.value)} className={field}>
                <option value="">先不引用</option>
                {items.map((i) => <option key={i.id} value={i.id}>{i.title}</option>)}
              </select>
            </label>
            <button type="submit" disabled={!name} className="btn-fju h-10 text-sm disabled:opacity-40">{name ? "上傳" : "先選檔案"}</button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
