"use client";

import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { IconCheck, IconCopy, IconDownload, IconKey, IconUserOff, IconUpload, IconX } from "@tabler/icons-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { buttonVariants } from "@/components/ui/button";
import { DataTable } from "@/components/data-table/data-table";
import { Pill } from "@/components/dashboard/primitives";
import { Stamp, TEXTAREA, fakeTime } from "@/components/dashboard/stamp";
import { ROLE_LABEL } from "@/lib/nav-config";
import type { Account } from "@/lib/fixtures";

const STATUS: Record<Account["status"], { label: string; tone: "success" | "warning" | "default" }> = { active: { label: "已核准", tone: "success" }, pending: { label: "待審核", tone: "warning" }, disabled: { label: "已停用", tone: "default" } };

/** 審核（Codex 09-10 A-05）：證據並列＝申請姓名／名冊姓名／學號／來源／屆別；退回必填理由。 */
function ApproveDialog({ a }: { a: Account }) {
  const [done, setDone] = useState<null | "approve" | "reject">(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const r = a.review;
  const nameMatch = r?.rosterName ? r.rosterName === a.name : null;
  const source = a.email.endsWith("fju.edu.tw") ? "校方信箱" : "外部 Email";
  function decide(kind: "approve" | "reject") {
    if (kind === "reject" && !reason.trim()) return setError("退回一定要寫理由，申請人會看到這段");
    setDone(kind);
  }
  return (
    <Dialog onOpenChange={(o) => { if (!o) { setDone(null); setReason(""); setError(null); } }}>
      <DialogTrigger render={<button type="button" className={buttonVariants({ size: "sm", className: "press rounded-lg" })} />}>審核</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        {done ? (
          <Stamp label={done === "approve" ? "已核准" : "已退回"} title={a.name} description={<>{fakeTime()}・比對依據、理由與操作者已寫入紀錄。{done === "reject" ? "申請人會收到退回理由。" : "本人下次登入即可使用。"}</>} />
        ) : (
          <div className="flex flex-col gap-4">
            <div><DialogTitle className="text-lg font-extrabold">審核 {a.name}</DialogTitle><DialogDescription className="mt-1">{r?.reason ?? "名單比對結果"}</DialogDescription></div>
            <dl className="grid grid-cols-[6rem_1fr] gap-y-2 rounded-lg border border-border px-4 py-3 text-sm">
              <dt className="text-muted-foreground">申請姓名</dt><dd className="font-semibold">{a.name}</dd>
              <dt className="text-muted-foreground">名冊姓名</dt><dd className={`font-semibold ${nameMatch === false ? "text-destructive" : ""}`}>{r?.rosterHit ? r.rosterName ?? a.name : <span className="text-destructive">未命中名單</span>}{nameMatch === false ? <span className="ml-2 text-xs font-normal text-muted-foreground">與申請姓名不同</span> : null}</dd>
              <dt className="text-muted-foreground">學號</dt><dd className="tabular font-semibold">{a.studentNo ?? "—"}</dd>
              <dt className="text-muted-foreground">來源</dt><dd className={`font-semibold ${source === "外部 Email" ? "text-destructive" : ""}`}>{source}<span className="ml-2 text-xs font-normal text-muted-foreground">{a.email}</span></dd>
              <dt className="text-muted-foreground">屆別</dt><dd className="tabular font-semibold">{a.cohort}{a.cohort !== "114" ? <span className="ml-2 text-xs font-normal text-destructive">非本屆</span> : null}</dd>
              <dt className="text-muted-foreground">送出</dt><dd className="tabular font-semibold">{a.createdAt}</dd>
            </dl>
            <label htmlFor={`rv-${a.id}`} className="flex flex-col gap-1.5 text-sm font-semibold">理由 <span className="font-normal text-muted-foreground">・退回必填，核准選填</span><textarea id={`rv-${a.id}`} rows={2} value={reason} onChange={(e) => { setReason(e.target.value); setError(null); }} placeholder="例：名單姓名有誤字，已向學生確認" className={TEXTAREA} aria-describedby={error ? `rv-err-${a.id}` : undefined} /></label>
            {error ? <p id={`rv-err-${a.id}`} role="alert" className="text-sm font-semibold text-destructive">{error}</p> : null}
            <div className="flex gap-2"><button type="button" onClick={() => decide("approve")} className="btn-fju h-11 flex-1 text-sm">核准</button><button type="button" onClick={() => decide("reject")} className={buttonVariants({ variant: "outline", size: "lg", className: "press h-11 flex-1 rounded-lg" })}>退回</button></div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 重設臨時密碼：產生一次、只顯示一次、寫入紀錄。 */
function ResetPasswordDialog({ a }: { a: Account }) {
  const [pw, setPw] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  function gen() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    setPw(Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join(""));
  }
  return (
    <Dialog onOpenChange={(o) => { if (!o) { setPw(null); setCopied(false); } }}>
      <DialogTrigger render={<button type="button" className={buttonVariants({ size: "sm", variant: "ghost", className: "press rounded-lg" })} aria-label={`重設 ${a.name} 的臨時密碼`} title="重設臨時密碼" />}><IconKey /></DialogTrigger>
      <DialogContent className="sm:max-w-md">
        {pw ? (
          <Stamp label="已重設" title={`${a.name} 的臨時密碼`} description={<>只顯示這一次，關閉後查不到。{fakeTime()} 已寫入操作紀錄；本人登入後必須改密碼。</>}>
            <div className="mt-1 flex w-full items-center gap-2 rounded-lg border border-border bg-muted/40 px-4 py-3">
              <code className="tabular flex-1 text-left text-lg font-extrabold tracking-[0.12em]">{pw}</code>
              <button type="button" onClick={() => { void navigator.clipboard?.writeText(pw); setCopied(true); }} className={buttonVariants({ size: "sm", variant: "outline", className: "press rounded-lg" })}>{copied ? <><IconCheck /> 已複製</> : <><IconCopy /> 複製</>}</button>
            </div>
          </Stamp>
        ) : (
          <div className="flex flex-col gap-4">
            <div><DialogTitle className="text-lg font-extrabold">重設 {a.name} 的臨時密碼</DialogTitle><DialogDescription className="mt-1">系統不存可查看的密碼。重設會讓舊密碼立刻失效，新的一次性密碼只顯示一次。</DialogDescription></div>
            <dl className="grid grid-cols-[5rem_1fr] gap-y-1.5 rounded-lg bg-muted px-4 py-3 text-sm"><dt className="text-muted-foreground">帳號</dt><dd className="font-semibold">{a.email}</dd><dt className="text-muted-foreground">角色</dt><dd className="font-semibold">{ROLE_LABEL[a.role]}</dd></dl>
            <button type="button" onClick={gen} className="btn-fju h-11 text-sm">產生一次性密碼</button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 停用／還原：確認 dialog，先講影響。 */
function ToggleStatusDialog({ a }: { a: Account }) {
  const disabling = a.status !== "disabled";
  const [done, setDone] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <Dialog onOpenChange={(o) => { if (!o) { setDone(false); setReason(""); } }}>
      <DialogTrigger render={<button type="button" className={buttonVariants({ size: "sm", variant: "ghost", className: "press rounded-lg" })} />}>{disabling ? "停用" : "還原"}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        {done ? (
          <Stamp label={disabling ? "已停用" : "已還原"} title={a.name} description={<>{fakeTime()}・{disabling ? "下一個受保護請求即被拒絕；資料與紀錄都保留，可隨時還原。" : "本人現在可以登入；期間的資料沒有變動。"}</>} />
        ) : (
          <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); setDone(true); }}>
            <div><DialogTitle className="text-lg font-extrabold">{disabling ? "停用" : "還原"} {a.name}</DialogTitle><DialogDescription className="mt-1">{disabling ? "停用不是刪除：本人無法登入，但繳交、成績與紀錄都保留。" : "還原後本人可立即登入，角色與學籍資料不變。"}</DialogDescription></div>
            <dl className="grid grid-cols-[5rem_1fr] gap-y-1.5 rounded-lg bg-muted px-4 py-3 text-sm"><dt className="text-muted-foreground">帳號</dt><dd className="font-semibold">{a.email}</dd><dt className="text-muted-foreground">學號</dt><dd className="tabular font-semibold">{a.studentNo ?? "—"}</dd><dt className="text-muted-foreground">目前</dt><dd><Pill tone={STATUS[a.status].tone}>{STATUS[a.status].label}</Pill></dd></dl>
            <label htmlFor={`tg-${a.id}`} className="flex flex-col gap-1.5 text-sm font-semibold">理由（選填）<textarea id={`tg-${a.id}`} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={disabling ? "例：休學" : "例：復學"} className={TEXTAREA} /></label>
            <button type="submit" className={disabling ? buttonVariants({ variant: "destructive", size: "lg", className: "press h-11 rounded-lg" }) : "btn-fju h-11 text-sm"}>{disabling ? "確認停用" : "確認還原"}</button>
          </form>
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
      <DialogContent className="sm:max-w-md">
        {done ? (
          <Stamp label="已停用" title={`${selected.length - already} 筆帳號`} description="下一個受保護請求即被拒絕；可隨時還原。" />
        ) : (
          <div className="flex flex-col gap-4">
            <div><DialogTitle className="text-lg font-extrabold">批次停用預覽</DialogTitle><DialogDescription className="mt-1">預設停用而非永久刪除。</DialogDescription></div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg bg-muted px-3 py-3"><p className="tabular text-2xl font-extrabold">{selected.length - already}</p><p className="text-xs text-muted-foreground">將停用</p></div>
              <div className="rounded-lg bg-muted px-3 py-3"><p className="tabular text-2xl font-extrabold">{already}</p><p className="text-xs text-muted-foreground">已停用</p></div>
              <div className="rounded-lg bg-muted px-3 py-3"><p className="tabular text-2xl font-extrabold">0</p><p className="text-xs text-muted-foreground">找不到</p></div>
            </div>
            <ul className="max-h-40 overflow-y-auto rounded-lg border border-border text-sm">{selected.map((s) => <li key={s.id} className="flex justify-between border-b border-border px-3 py-1.5 last:border-0"><span>{s.name}</span><span className="tabular text-muted-foreground">{s.studentNo ?? s.email}</span></li>)}</ul>
            <button type="button" onClick={() => setDone(true)} className="btn-fju h-11 text-sm">確認停用</button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function AccountsTable({ accounts, initialStatus }: { accounts: Account[]; initialStatus?: string }) {
  const columns: ColumnDef<Account, unknown>[] = useMemo(() => [
    { id: "select", meta: { label: "勾選", width: "44px" }, enableSorting: false, enableHiding: false, header: ({ table }) => <Checkbox checked={table.getIsAllPageRowsSelected()} indeterminate={table.getIsSomePageRowsSelected()} onCheckedChange={(v) => table.toggleAllPageRowsSelected(!!v)} aria-label="全選本頁" />, cell: ({ row }) => <Checkbox checked={row.getIsSelected()} onCheckedChange={(v) => row.toggleSelected(!!v)} aria-label={`選取 ${row.original.name}`} /> },
    { accessorKey: "name", meta: { label: "姓名", width: "140px" }, header: "姓名", cell: ({ row }) => <span className="flex items-center gap-2"><span className="inline-flex size-7 items-center justify-center rounded-full bg-brand-subtle text-[11px] font-bold text-brand-on-subtle">{row.original.name.slice(0, 1)}</span><span className="font-semibold">{row.original.name}</span>{row.original.review?.rosterName && row.original.review.rosterName !== row.original.name ? <span className="text-xs text-muted-foreground">名冊：{row.original.review.rosterName}</span> : null}</span> },
    { accessorKey: "studentNo", meta: { label: "學號", width: "120px" }, header: "學號", cell: ({ row }) => <span className="tabular text-sm">{row.original.studentNo ?? "—"}</span> },
    { accessorKey: "email", meta: { label: "Email", width: "200px" }, header: "Email", cell: ({ row }) => <span className="block truncate text-sm text-muted-foreground">{row.original.email}</span> },
    { accessorKey: "role", meta: { label: "角色", width: "110px" }, header: "角色", filterFn: (row, id, v: string[]) => v.includes(String(row.getValue(id))), cell: ({ row }) => <span className="text-sm">{ROLE_LABEL[row.original.role]}</span> },
    { accessorKey: "cohort", meta: { label: "屆別", width: "80px" }, header: "屆別", filterFn: (row, id, v: string[]) => v.includes(String(row.getValue(id))), cell: ({ row }) => <span className="tabular text-sm">{row.original.cohort}</span> },
    { accessorKey: "status", meta: { label: "狀態", width: "150px" }, header: "狀態", filterFn: (row, id, v: string[]) => v.includes(String(row.getValue(id))), cell: ({ row }) => <span className="flex items-center gap-2"><Pill tone={STATUS[row.original.status].tone}>{STATUS[row.original.status].label}</Pill>{row.original.review ? <span className="truncate text-xs text-muted-foreground">{row.original.review.reason}</span> : null}</span> },
    { accessorKey: "createdAt", meta: { label: "建立", width: "110px" }, header: "建立", cell: ({ row }) => <span className="tabular text-sm text-muted-foreground">{row.original.createdAt}</span> },
    { id: "actions", meta: { label: "操作", width: "120px" }, enableSorting: false, enableHiding: false, header: "操作", cell: ({ row }) => row.original.status === "pending" ? <ApproveDialog a={row.original} /> : <span className="flex gap-1"><ResetPasswordDialog a={row.original} /><ToggleStatusDialog a={row.original} /></span> },
  ], []);

  const cohorts = [...new Set(accounts.map((a) => a.cohort))].map((c) => ({ value: c, label: c }));
  return (
    <DataTable
      key={initialStatus ?? "all"}
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
          <span className="inline-flex items-center gap-1.5"><button type="button" disabled title="尚未提供" className={buttonVariants({ size: "sm", variant: "outline", className: "press rounded-lg" })}><IconDownload /> 匯出 CSV（{selected.length}）</button><span className="text-[11px] text-muted-foreground">尚未提供</span></span>
          <BulkDisableDialog selected={selected} clear={clear} />
        </>
      )}
      emptyTitle="沒有帳號"
    />
  );
}

/** 篩選標籤（從首頁四磚帶 ?status= 進來時顯示，可移除） */
export function FilterTag({ label, count, total, clearHref }: { label: string; count: number; total: number; clearHref: string }) {
  return (
    <span className="inline-flex h-9 items-center gap-2 rounded-full border border-brand bg-brand-subtle pl-3.5 pr-1.5 text-sm font-semibold text-brand-on-subtle">
      篩選：{label} <span className="tabular">{count}／{total} 筆</span>
      <a href={clearHref} className="inline-flex size-6 items-center justify-center rounded-full transition-colors hover:bg-brand hover:text-brand-foreground" aria-label="移除篩選"><IconX className="size-3.5" /></a>
    </span>
  );
}

/** 匯入本屆名單 CSV（規格 §2.4）：先預覽總筆數、有效、重複、缺欄、衝突 */
export function ImportRosterDialog() {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  return (
    <Dialog onOpenChange={(o) => !o && setStep(0)}>
      <DialogTrigger render={<button type="button" className={buttonVariants({ variant: "outline", size: "lg", className: "press rounded-lg" })} />}><IconUpload /> 匯入名單 CSV</DialogTrigger>
      <DialogContent className="sm:max-w-md">
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
            <button type="button" onClick={() => setStep(2)} className="btn-fju h-11 text-sm">匯入 49 筆</button>
          </div>
        ) : (
          <Stamp label="已匯入" title="49 筆名單" description={<>{fakeTime()}・之後註冊命中名單者自動核准；比對依據與匯入時間已記錄。</>} />
        )}
      </DialogContent>
    </Dialog>
  );
}
