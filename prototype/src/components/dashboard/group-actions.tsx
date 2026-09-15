"use client";

import { useState } from "react";
import { IconCheck, IconHandGrab, IconUserPlus, IconAlertTriangle } from "@tabler/icons-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { buttonVariants } from "@/components/ui/button";
import { INPUT, Stamp, TEXTAREA, fakeTime } from "@/components/dashboard/stamp";
import { GROUPS, TEACHERS } from "@/lib/fixtures";

/** 老師認領產學組（規格 §5.4）：first-success；同時操作只有一位成功。 */
export function ClaimDialog({ groupNo, title, size = "sm" }: { groupNo: string; title: string; size?: "sm" | "lg" }) {
  const [state, setState] = useState<"idle" | "ok" | "conflict">("idle");
  const clean = title.replace(/（產學：.*）/, "");
  return (
    <Dialog onOpenChange={(o) => !o && setState("idle")}>
      <DialogTrigger render={<button type="button" className={buttonVariants({ size, variant: "outline", className: "press rounded-lg" })} />}><IconHandGrab /> 認領</DialogTrigger>
      <DialogContent className="max-w-md">
        {state === "ok" ? (
          <div className="flex flex-col items-center gap-3 py-2 text-center">
            <span className="animate-in fade-in-0 zoom-in-95 inline-flex -rotate-2 items-center gap-1.5 rounded-lg border-2 border-success px-3 py-1.5 text-sm font-extrabold tracking-[0.12em] text-success-on-subtle duration-300"><IconCheck className="size-4" strokeWidth={3} />已認領</span>
            <DialogTitle className="text-lg font-extrabold">{groupNo} 已指定為你的組別</DialogTitle>
            <DialogDescription>{clean}。已通知全組與系辦。</DialogDescription>
          </div>
        ) : state === "conflict" ? (
          <div className="flex flex-col items-center gap-3 py-2 text-center"><span className="inline-flex size-12 items-center justify-center rounded-full bg-warning-subtle text-warning-on-subtle"><IconAlertTriangle className="size-6" /></span><DialogTitle className="text-lg font-extrabold">已被其他老師認領</DialogTitle><DialogDescription>{groupNo} 剛由王雅玲老師認領成功。需要調整請洽系辦重派。</DialogDescription></div>
        ) : (
          <div className="flex flex-col gap-4">
            <div><DialogTitle className="text-lg font-extrabold">認領 {groupNo}</DialogTitle><DialogDescription className="mt-1">{clean}。先按先得；同時操作只有一位會成功。</DialogDescription></div>
            <button type="button" onClick={() => setState("ok")} className="btn-fju h-11 text-sm">確認認領</button>
            <button type="button" onClick={() => setState("conflict")} className="self-end text-[11px] text-muted-foreground underline-offset-2 hover:underline">原型：模擬被其他老師先認領</button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 管理員指派／重派指導老師（規格 §5.4）：必填理由。 */
export function AssignDialog({ groupNo, current }: { groupNo: string; current?: string }) {
  const [done, setDone] = useState(false);
  const [teacher, setTeacher] = useState(TEACHERS.find((t) => t.name !== current)?.name ?? TEACHERS[0].name);
  const [reason, setReason] = useState("");
  return (
    <Dialog onOpenChange={(o) => { if (!o) { setDone(false); setReason(""); } }}>
      <DialogTrigger render={<button type="button" className={buttonVariants({ size: "sm", variant: current ? "ghost" : "outline", className: "press rounded-lg" })} />}><IconUserPlus /> {current ? "重派" : "指派老師"}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        {done ? (
          <Stamp label={current ? "已重派" : "已指派"} title={`${groupNo}・${teacher}`} description={<>{fakeTime()}・{current ? `原指導老師 ${current} 與` : ""}全組已收到通知；理由與操作者已寫入紀錄。</>} />
        ) : (
          <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); setDone(true); }}>
            <div><DialogTitle className="text-lg font-extrabold">{current ? "重派" : "指派"}指導老師・{groupNo}</DialogTitle><DialogDescription className="mt-1">{current ? `目前：${current}。重派後原老師的評分與簽核指派會一併移轉。` : "一般專題由系辦依抽籤結果指派；產學組由老師認領。"}</DialogDescription></div>
            <label htmlFor={`as-t-${groupNo}`} className="flex flex-col gap-1.5 text-sm font-semibold">老師<select id={`as-t-${groupNo}`} value={teacher} onChange={(e) => setTeacher(e.target.value)} className={INPUT}>{TEACHERS.map((t) => <option key={t.id} value={t.name} disabled={t.name === current}>{t.name}{t.name === current ? "（目前）" : ""}</option>)}</select></label>
            <label htmlFor={`as-r-${groupNo}`} className="flex flex-col gap-1.5 text-sm font-semibold">理由（必填）<textarea id={`as-r-${groupNo}`} required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例：抽籤結果" className={TEXTAREA} /></label>
            <button type="submit" className="btn-fju h-11 text-sm">確認{current ? "重派" : "指派"}</button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 管理員：把未分組學生加入某組（Codex 09-10 A-04）。只列還有位子的組；理由必填。 */
export function JoinGroupDialog({ student }: { student: { id: string; name: string; studentNo: string; openToJoin: boolean } }) {
  const open = GROUPS.filter((g) => g.members.length < 5);
  const [groupId, setGroupId] = useState(open[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const [done, setDone] = useState(false);
  const target = GROUPS.find((g) => g.id === groupId);
  return (
    <Dialog onOpenChange={(o) => { if (!o) { setDone(false); setReason(""); } }}>
      <DialogTrigger render={<button type="button" className={buttonVariants({ size: "sm", variant: "outline", className: "press rounded-lg" })} />}><IconUserPlus /> 加入某組</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        {done ? (
          <Stamp label="已加入" title={`${student.name} → ${target?.no}`} description={<>{fakeTime()}・{target?.no} 現在 {(target?.members.length ?? 0) + 1} 人，全組與本人已收到通知；名單需五位成員各自再確認一次。</>} />
        ) : (
          <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); setDone(true); }}>
            <div><DialogTitle className="text-lg font-extrabold">把 {student.name} 加入組別</DialogTitle><DialogDescription className="mt-1">{student.studentNo}・{student.openToJoin ? "本人有公開找組員" : "本人未公開找組員，加入前請先聯絡"}。只列出還不滿五人的組。</DialogDescription></div>
            {open.length ? (
              <label htmlFor={`jg-g-${student.id}`} className="flex flex-col gap-1.5 text-sm font-semibold">組別<select id={`jg-g-${student.id}`} value={groupId} onChange={(e) => setGroupId(e.target.value)} className={INPUT}>{open.map((g) => <option key={g.id} value={g.id}>{g.no}・{g.members.length} 人・{g.title.replace(/（產學：.*）/, "")}</option>)}</select></label>
            ) : <p className="text-sm text-destructive">每組都滿五人了；請先用組別詳情調整人數。</p>}
            <label htmlFor={`jg-r-${student.id}`} className="flex flex-col gap-1.5 text-sm font-semibold">理由（必填）<textarea id={`jg-r-${student.id}`} required rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例：系上安排（規則 §4 註一）" className={TEXTAREA} /></label>
            <button type="submit" disabled={!open.length} className="btn-fju h-11 text-sm disabled:cursor-not-allowed disabled:opacity-50">確認加入</button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
