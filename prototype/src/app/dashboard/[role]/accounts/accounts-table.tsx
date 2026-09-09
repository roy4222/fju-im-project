"use client";

import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { IconCheck, IconDownload, IconUserOff, IconKey, IconUpload } from "@tabler/icons-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { buttonVariants } from "@/components/ui/button";
import { DataTable } from "@/components/data-table/data-table";
import { Pill } from "@/components/dashboard/primitives";
import { ROLE_LABEL } from "@/lib/nav-config";
import type { Account } from "@/lib/fixtures";

const STATUS: Record<Account["status"], { label: string; tone: "success" | "warning" | "default" }> = { active: { label: "已核准", tone: "success" }, pending: { label: "待審核", tone: "warning" }, disabled: { label: "已停用", tone: "default" } };

function ApproveDialog({ a }: { a: Account }) {
  const [done, setDone] = useState<null | "approve" | "reject">(null);
  return (
    <Dialog onOpenChange={(o) => !o && setDone(null)}>
      <DialogTrigger render={<button type="button" className={buttonVariants({ size: "sm", className: "press rounded-lg" })} />}>審核</DialogTrigger>
      <DialogContent className="max-w-md">
        {done ? (
          <div className="flex flex-col items-center gap-3 text-center"><span className={`inline-flex size-12 items-center justify-center rounded-full ${done === "approve" ? "bg-success-subtle text-success-on-subtle" : "bg-muted text-muted-foreground"}`}><IconCheck className="size-6" /></span><DialogTitle className="text-lg font-extrabold">{done === "approve" ? "已核准" : "已退回"} {a.name}</DialogTitle><DialogDescription>比對依據、操作者與時間已記錄。</DialogDescription></div>
        ) : (
          <div className="flex flex-col gap-4">
            <div><DialogTitle className="text-lg font-extrabold">審核 {a.name}</DialogTitle><DialogDescription className="mt-1">名單比對結果：{a.cohort === "114" ? "學號命中、姓名有差異" : "非本屆屆別"}</DialogDescription></div>
            <dl className="grid grid-cols-[5rem_1fr] gap-y-1.5 rounded-lg bg-muted px-4 py-3 text-sm">
              <dt className="text-muted-foreground">學號</dt><dd className="tabular font-semibold">{a.studentNo}</dd>
              <dt className="text-muted-foreground">Email</dt><dd className="font-semibold">{a.email}</dd>
              <dt className="text-muted-foreground">屆別</dt><dd className="font-semibold">{a.cohort}</dd>
              <dt className="text-muted-foreground">送出</dt><dd className="tabular font-semibold">{a.createdAt}</dd>
            </dl>
            <div className="flex gap-2"><button type="button" onClick={() => setDone("approve")} className="btn-fju h-10 flex-1 text-sm">核准</button><button type="button" onClick={() => setDone("reject")} className={buttonVariants({ variant: "outline", size: "lg", className: "press flex-1 rounded-lg" })}>退回</button></div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function BulkDisableDialog({ selected, clear }: { selected: Account[]; clear: () => void }) {
  const [done, setDone] = useState(false);
  const already = selected.filter((s) => s.status === "disabled").length;
  return (
    <Dialog onOpenChange={(o) => { if (!o && done) { clear(); setDone(false); } }}>
      <DialogTrigger render={<button type="button" className={buttonVariants({ size: "sm", variant: "outline", className: "press rounded-lg" })} />}><IconUserOff /> 停用 {selected.length} 筆</DialogTrigger>
      <DialogContent className="max-w-md">
        {done ? (
          <div className="flex flex-col items-center gap-3 text-center"><span className="inline-flex size-12 items-center justify-center rounded-full bg-success-subtle text-success-on-subtle"><IconCheck className="size-6" /></span><DialogTitle className="text-lg font-extrabold">已停用 {selected.length - already} 筆</DialogTitle><DialogDescription>下一個受保護請求即被拒絕；可隨時還原。</DialogDescription></div>
        ) : (
          <div className="flex flex-col gap-4">
            <div><DialogTitle className="text-lg font-extrabold">批次停用預覽</DialogTitle><DialogDescription className="mt-1">預設停用而非永久刪除。</DialogDescription></div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg bg-muted px-3 py-3"><p className="tabular text-2xl font-extrabold">{selected.length - already}</p><p className="text-xs text-muted-foreground">將停用</p></div>
              <div className="rounded-lg bg-muted px-3 py-3"><p className="tabular text-2xl font-extrabold">{already}</p><p className="text-xs text-muted-foreground">已停用</p></div>
              <div className="rounded-lg bg-muted px-3 py-3"><p className="tabular text-2xl font-extrabold">0</p><p className="text-xs text-muted-foreground">找不到</p></div>
            </div>
            <ul className="max-h-40 overflow-y-auto rounded-lg border border-border text-sm">{selected.map((s) => <li key={s.id} className="flex justify-between border-b border-border px-3 py-1.5 last:border-0"><span>{s.name}</span><span className="tabular text-muted-foreground">{s.studentNo ?? s.email}</span></li>)}</ul>
            <button type="button" onClick={() => setDone(true)} className="btn-fju h-10 text-sm">確認停用</button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function AccountsTable({ accounts, initialStatus }: { accounts: Account[]; initialStatus?: string }) {
  const columns: ColumnDef<Account, unknown>[] = useMemo(() => [
    { id: "select", meta: { label: "勾選", width: "44px" }, enableSorting: false, enableHiding: false, header: ({ table }) => <Checkbox checked={table.getIsAllPageRowsSelected()} indeterminate={table.getIsSomePageRowsSelected()} onCheckedChange={(v) => table.toggleAllPageRowsSelected(!!v)} aria-label="全選本頁" />, cell: ({ row }) => <Checkbox checked={row.getIsSelected()} onCheckedChange={(v) => row.toggleSelected(!!v)} aria-label={`選取 ${row.original.name}`} /> },
    { accessorKey: "name", meta: { label: "姓名", width: "140px" }, header: "姓名", cell: ({ row }) => <span className="flex items-center gap-2"><span className="inline-flex size-7 items-center justify-center rounded-full bg-brand-subtle text-[11px] font-bold text-brand-on-subtle">{row.original.name.slice(0, 1)}</span><span className="font-semibold">{row.original.name}</span></span> },
    { accessorKey: "studentNo", meta: { label: "學號", width: "120px" }, header: "學號", cell: ({ row }) => <span className="tabular text-sm">{row.original.studentNo ?? "—"}</span> },
    { accessorKey: "email", meta: { label: "Email", width: "240px" }, header: "Email", cell: ({ row }) => <span className="block truncate text-sm text-muted-foreground">{row.original.email}</span> },
    { accessorKey: "role", meta: { label: "角色", width: "110px" }, header: "角色", filterFn: (row, id, v: string[]) => v.includes(String(row.getValue(id))), cell: ({ row }) => <span className="text-sm">{ROLE_LABEL[row.original.role]}</span> },
    { accessorKey: "cohort", meta: { label: "屆別", width: "80px" }, header: "屆別", filterFn: (row, id, v: string[]) => v.includes(String(row.getValue(id))), cell: ({ row }) => <span className="tabular text-sm">{row.original.cohort}</span> },
    { accessorKey: "status", meta: { label: "狀態", width: "100px" }, header: "狀態", filterFn: (row, id, v: string[]) => v.includes(String(row.getValue(id))), cell: ({ row }) => <Pill tone={STATUS[row.original.status].tone}>{STATUS[row.original.status].label}</Pill> },
    { accessorKey: "createdAt", meta: { label: "建立", width: "110px" }, header: "建立", cell: ({ row }) => <span className="tabular text-sm text-muted-foreground">{row.original.createdAt}</span> },
    { id: "actions", meta: { label: "操作", width: "150px" }, enableSorting: false, enableHiding: false, header: "操作", cell: ({ row }) => row.original.status === "pending" ? <ApproveDialog a={row.original} /> : <span className="flex gap-1"><button type="button" className={buttonVariants({ size: "sm", variant: "ghost", className: "press rounded-lg" })} title="重設臨時密碼"><IconKey /></button><button type="button" className={buttonVariants({ size: "sm", variant: "ghost", className: "press rounded-lg" })}>{row.original.status === "disabled" ? "還原" : "停用"}</button></span> },
  ], []);

  const cohorts = [...new Set(accounts.map((a) => a.cohort))].map((c) => ({ value: c, label: c }));
  return (
    <DataTable
      columns={columns}
      data={accounts}
      searchColumnId="name"
      searchPlaceholder="搜尋姓名"
      initialColumnFilters={initialStatus ? [{ id: "status", value: [initialStatus] }] : undefined}
      facets={[
        { columnId: "status", label: "狀態", options: [{ value: "pending", label: "待審核" }, { value: "active", label: "已核准" }, { value: "disabled", label: "已停用" }] },
        { columnId: "role", label: "角色", options: [{ value: "student", label: "學生" }, { value: "teacher", label: "老師" }, { value: "admin", label: "管理員" }] },
        { columnId: "cohort", label: "屆別", options: cohorts },
      ]}
      bulkActions={(selected, clear) => (
        <>
          <button type="button" className={buttonVariants({ size: "sm", variant: "outline", className: "press rounded-lg" })}><IconDownload /> 匯出 CSV（{selected.length}）</button>
          <BulkDisableDialog selected={selected} clear={clear} />
        </>
      )}
      emptyTitle="沒有帳號"
    />
  );
}

/** 匯入本屆名單 CSV（規格 §2.4）：先預覽總筆數、有效、重複、缺欄、衝突 */
export function ImportRosterDialog() {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  return (
    <Dialog onOpenChange={(o) => !o && setStep(0)}>
      <DialogTrigger render={<button type="button" className={buttonVariants({ variant: "outline", size: "lg", className: "press rounded-lg" })} />}><IconUpload /> 匯入名單 CSV</DialogTrigger>
      <DialogContent className="max-w-md">
        {step === 0 ? (
          <div className="flex flex-col gap-4">
            <div><DialogTitle className="text-lg font-extrabold">匯入本屆名單</DialogTitle><DialogDescription className="mt-1">UTF-8 CSV，欄位固定：<code className="rounded bg-muted px-1">student_no,name,cohort,email</code></DialogDescription></div>
            <label className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-8 text-sm transition-colors hover:border-brand hover:bg-brand-subtle/30"><IconUpload className="size-6 text-brand" /><span className="font-semibold">選擇檔案或拖放</span><input type="file" accept=".csv" className="sr-only" onChange={() => setStep(1)} /></label>
            <button type="button" onClick={() => setStep(1)} className={buttonVariants({ variant: "outline", size: "lg", className: "press rounded-lg" })}>用示範檔預覽</button>
          </div>
        ) : step === 1 ? (
          <div className="flex flex-col gap-4">
            <div><DialogTitle className="text-lg font-extrabold">預覽・114 名單 v4.csv</DialogTitle><DialogDescription className="mt-1">確認後才匯入；不會自動核准衝突筆。</DialogDescription></div>
            <div className="grid grid-cols-4 gap-2 text-center">
              {[["52", "總筆數", ""], ["49", "有效", "text-success-on-subtle"], ["2", "重複", "text-warning-on-subtle"], ["1", "缺欄", "text-destructive"]].map(([n, l, c]) => <div key={l} className="rounded-lg bg-muted px-2 py-3"><p className={`tabular text-2xl font-extrabold ${c}`}>{n}</p><p className="text-xs text-muted-foreground">{l}</p></div>)}
            </div>
            <ul className="rounded-lg border border-border text-xs"><li className="flex justify-between border-b border-border px-3 py-1.5"><span>第 17 行 411410466 重複</span><span className="text-warning-on-subtle">略過</span></li><li className="flex justify-between border-b border-border px-3 py-1.5"><span>第 33 行 411410466 重複</span><span className="text-warning-on-subtle">略過</span></li><li className="flex justify-between px-3 py-1.5"><span>第 41 行缺 name</span><span className="text-destructive">略過</span></li></ul>
            <button type="button" onClick={() => setStep(2)} className="btn-fju h-10 text-sm">匯入 49 筆</button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 text-center"><span className="inline-flex size-12 items-center justify-center rounded-full bg-success-subtle text-success-on-subtle"><IconCheck className="size-6" /></span><DialogTitle className="text-lg font-extrabold">已匯入 49 筆（名單 v4）</DialogTitle><DialogDescription>之後註冊命中名單者自動核准；比對依據與名單版本已記錄。</DialogDescription></div>
        )}
      </DialogContent>
    </Dialog>
  );
}
