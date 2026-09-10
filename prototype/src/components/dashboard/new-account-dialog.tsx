"use client";

import { useState } from "react";
import { IconUserPlus } from "@tabler/icons-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { buttonVariants } from "@/components/ui/button";
import { INPUT, Stamp, fakeTime } from "@/components/dashboard/stamp";
import { COHORT, type Role } from "@/lib/fixtures";

const ROLES: { key: Role; label: string; hint: string }[] = [
  { key: "student", label: "學生", hint: "作業區、我的組別、同意書" },
  { key: "teacher", label: "老師", hint: "評分、簽核、分組總覽" },
  { key: "admin", label: "管理員", hint: "全部管理頁與操作紀錄" },
];

/**
 * 新增帳號（Codex 09-10 A-04）：平台角色 vs 學籍資料要分清楚。
 * 平台角色＝能進哪些頁；學籍資料（學號、屆別）＝來自名單，用來比對與分組。
 */
export function NewAccountDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("student");
  const [studentNo, setStudentNo] = useState("");
  const [cohort, setCohort] = useState(COHORT.code);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const isStudent = role === "student";

  function reset() { setName(""); setEmail(""); setRole("student"); setStudentNo(""); setCohort(COHORT.code); setError(null); setDone(false); }
  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("姓名不能空白");
    if (!/^\S+@\S+\.\S+$/.test(email)) return setError("Email 格式不對，例：411410123@m365.fju.edu.tw");
    if (isStudent && !/^\d{9}$/.test(studentNo)) return setError("學號需為 9 位數字");
    setDone(true);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setTimeout(reset, 200); }}>
      <DialogTrigger render={<button type="button" className="btn-fju h-10 px-4 text-sm" />}><IconUserPlus className="size-4" /> 新增帳號</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        {done ? (
          <Stamp label="已建立" title={`${name}・${ROLES.find((r) => r.key === role)?.label}`} description={<>{fakeTime()} 建立。臨時密碼已寄到 {email}，只能用一次；本人首次登入需改密碼。</>}>
            <button type="button" onClick={() => setOpen(false)} className={buttonVariants({ variant: "outline", size: "lg", className: "press mt-1 rounded-lg" })}>關閉</button>
          </Stamp>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div>
              <DialogTitle className="text-lg font-extrabold">新增帳號</DialogTitle>
              <DialogDescription className="mt-1">平台角色決定能進哪些頁；學籍資料（學號、屆別）來自名單，只用來比對身分與分組，改角色不會改學籍。</DialogDescription>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label htmlFor="na-name" className="flex flex-col gap-1.5 text-sm font-semibold">姓名<input id="na-name" value={name} onChange={(e) => { setName(e.target.value); setError(null); }} className={INPUT} autoFocus /></label>
              <label htmlFor="na-email" className="flex flex-col gap-1.5 text-sm font-semibold">Email<input id="na-email" type="email" value={email} onChange={(e) => { setEmail(e.target.value); setError(null); }} placeholder="校方信箱優先" className={INPUT} /></label>
            </div>
            <fieldset>
              <legend className="mb-1.5 text-sm font-semibold">平台角色</legend>
              <div className="grid grid-cols-3 gap-2">
                {ROLES.map((r) => (
                  <label key={r.key} className={`flex cursor-pointer flex-col gap-0.5 rounded-lg border px-3 py-2 transition-colors ${role === r.key ? "border-brand bg-brand-subtle/40" : "border-border hover:border-primary/40"}`}>
                    <span className="flex items-center gap-2 text-sm font-bold"><input type="radio" name="na-role" value={r.key} checked={role === r.key} onChange={() => setRole(r.key)} className="accent-brand" />{r.label}</span>
                    <span className="text-[11px] text-muted-foreground">{r.hint}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="grid gap-3 sm:grid-cols-2">
              {isStudent ? <label htmlFor="na-no" className="flex flex-col gap-1.5 text-sm font-semibold">學號<input id="na-no" inputMode="numeric" value={studentNo} onChange={(e) => { setStudentNo(e.target.value); setError(null); }} placeholder="9 位數字" className={`${INPUT} tabular`} /></label> : null}
              <label htmlFor="na-cohort" className="flex flex-col gap-1.5 text-sm font-semibold">屆別<select id="na-cohort" value={cohort} onChange={(e) => setCohort(e.target.value)} className={INPUT}><option value="114">114 學年度</option><option value="113">113 學年度</option><option value="—">不適用（老師／系辦）</option></select></label>
            </div>
            {error ? <p role="alert" className="text-sm font-semibold text-destructive">{error}</p> : null}
            <button type="submit" className="btn-fju h-11 text-sm">建立並寄送臨時密碼</button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
