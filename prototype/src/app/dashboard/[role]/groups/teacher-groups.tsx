"use client";

import { useState } from "react";
import { IconBriefcase, IconCheck, IconLink, IconPlus, IconX } from "@tabler/icons-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { IndustryFormDialog } from "@/components/dashboard/industry-form";
import { MemberStack, PageHead, TabBar } from "@/components/dashboard/teacher-v2";
import { GROUPS, INDUSTRY, type Group } from "@/lib/fixtures";
import { CASE_STATUS_LABEL, TEACHER_BASE as base, industryGroups, myCases, myGroups, openIndustryGroups, shortTitle, type CaseStatus, type MyCase } from "@/lib/teacher-v2";

/**
 * 老師：分組總覽 v2（Roy 2026-10-15，Q80、Q82）。分頁 我的組別｜合作案。
 * 我的組別：卡片（組名、組員頭像、類型）＋還沒有老師的產學組可以「擔任指導老師」。
 * 合作案：自己的合作案（發布中／草稿／已下架），負責老師可以把產學組連到自己的合作案。
 * 原型：全部是本地 state，重新整理就回到假資料。
 */
export function TeacherGroups({ tab }: { tab?: string }) {
  const active = tab === "industry" ? "industry" : "mine";
  return (
    <div className="flex flex-col gap-6">
      <PageHead title="分組總覽" />
      <TabBar
        label="分組總覽分頁"
        active={active}
        tabs={[
          { key: "mine", label: "我的組別", href: `${base}/groups` },
          { key: "industry", label: "合作案", href: `${base}/groups?tab=industry` },
        ]}
      />
      {active === "mine" ? <MineTab /> : <CasesTab />}
    </div>
  );
}

/* ---------------------------------------------------------------- 我的組別 */
function GroupCard({ g, fresh }: { g: Group; fresh?: boolean }) {
  return (
    <article className="dash-card flex h-full flex-col gap-4 p-5" data-group-card={g.id}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="tabular text-[12px] font-bold text-muted-foreground">{g.no}</p>
          <h3 className="mt-0.5 text-[17px] leading-snug font-extrabold">{shortTitle(g.title)}</h3>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-[12px] font-bold ${g.type === "INDUSTRY" ? "bg-[oklch(0.94_0.04_300)] text-[oklch(0.45_0.15_300)]" : "bg-accent text-primary"}`}>{g.type === "INDUSTRY" ? "產學合作" : "一般專題"}</span>
      </div>
      <div className="mt-auto flex items-center justify-between gap-3">
        <MemberStack members={g.members} />
        {fresh ? <span className="inline-flex items-center gap-1 text-[13px] font-bold text-success-on-subtle"><IconCheck className="size-4" />剛擔任</span> : null}
      </div>
    </article>
  );
}

function MineTab() {
  const [taken, setTaken] = useState<string[]>([]);
  const mine = [...myGroups(), ...GROUPS.filter((g) => taken.includes(g.id))];
  const open = openIndustryGroups().filter((g) => !taken.includes(g.id));
  return (
    <>
      <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" data-my-groups>
        {mine.map((g) => <li key={g.id}><GroupCard g={g} fresh={taken.includes(g.id)} /></li>)}
      </ul>

      {open.length ? (
        <section aria-labelledby="open-title" className="flex flex-col gap-3" data-open-groups>
          <h2 id="open-title" className="text-[17px] font-extrabold">還沒有指導老師的產學組</h2>
          <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {open.map((g) => (
              <li key={g.id} className="flex flex-col gap-4 rounded-3xl border border-dashed border-border bg-card/60 p-5">
                <div>
                  <p className="tabular text-[12px] font-bold text-muted-foreground">{g.no}</p>
                  <h3 className="mt-0.5 text-[17px] leading-snug font-extrabold">{shortTitle(g.title)}</h3>
                  <p className="mt-0.5 text-[13px] text-muted-foreground">{INDUSTRY.find((i) => i.id === g.industryId)?.company}</p>
                </div>
                <div className="mt-auto flex items-center justify-between gap-3">
                  <MemberStack members={g.members} />
                  <AdviseButton g={g} onConfirm={() => setTaken((t) => [...t, g.id])} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function AdviseButton({ g, onConfirm }: { g: Group; onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<button type="button" className="inline-flex h-10 shrink-0 items-center rounded-xl bg-brand px-4 text-sm font-bold text-white transition-colors hover:bg-brand/90" />}>擔任指導老師</DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogTitle className="text-lg font-extrabold">擔任指導老師？</DialogTitle>
        <DialogDescription>{g.no}・{shortTitle(g.title)}</DialogDescription>
        <div className="mt-2 flex gap-2">
          <button type="button" onClick={() => { setOpen(false); onConfirm(); }} className="btn-fju h-11 flex-1 rounded-lg text-sm">確定</button>
          <button type="button" onClick={() => setOpen(false)} className="h-11 flex-1 rounded-lg text-sm font-bold ring-1 ring-border hover:bg-accent">取消</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- 合作案 */
const CASE_CHIP: Record<CaseStatus, string> = {
  public: "bg-success-subtle text-success-on-subtle",
  draft: "bg-accent text-primary",
  unlisted: "bg-muted text-muted-foreground",
};

function CasesTab() {
  const [cases, setCases] = useState<MyCase[]>(myCases);
  /* 一個產學組只連一個合作案：連到別的案子時，從原本的案子拿掉 */
  function link(caseId: string, groupId: string) {
    setCases((cs) => cs.map((c) => ({ ...c, groupIds: c.id === caseId ? [...c.groupIds.filter((x) => x !== groupId), groupId] : c.groupIds.filter((x) => x !== groupId) })));
  }
  function unlink(caseId: string, groupId: string) {
    setCases((cs) => cs.map((c) => (c.id === caseId ? { ...c, groupIds: c.groupIds.filter((x) => x !== groupId) } : c)));
  }
  return (
    <>
      <div className="flex justify-end"><IndustryFormDialog /></div>
      <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" data-cases>
        {cases.map((c) => (
          <li key={c.id}>
            <article className="dash-card flex h-full flex-col gap-4 p-5" data-case={c.status}>
              <div className="flex items-start justify-between gap-3">
                <span className="inline-flex size-11 items-center justify-center rounded-2xl bg-accent text-primary"><IconBriefcase className="size-5" /></span>
                <span className={`rounded-full px-2.5 py-1 text-[12px] font-bold ${CASE_CHIP[c.status]}`}>{CASE_STATUS_LABEL[c.status]}</span>
              </div>
              <div>
                <p className="text-[13px] font-bold text-muted-foreground">{c.company}</p>
                <h3 className="mt-0.5 text-[17px] leading-snug font-extrabold">{c.title}</h3>
              </div>
              <div className="mt-auto flex flex-col gap-3">
                {c.groupIds.length ? (
                  <ul className="flex flex-wrap gap-2" data-linked>
                    {c.groupIds.map((id) => {
                      const g = GROUPS.find((x) => x.id === id)!;
                      return (
                        <li key={id} className="inline-flex items-center gap-1 rounded-full bg-muted/70 py-1 pr-1 pl-3 text-[13px] font-semibold">
                          {g.no.replace("第 ", "G").replace(" 組", "")}・{shortTitle(g.title)}
                          <button type="button" onClick={() => unlink(c.id, id)} aria-label={`取消連結 ${g.no}`} className="inline-flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-card hover:text-foreground"><IconX className="size-3.5" /></button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
                <LinkDialog c={c} cases={cases} onLink={(gid) => link(c.id, gid)} />
              </div>
            </article>
          </li>
        ))}
      </ul>
    </>
  );
}

function LinkDialog({ c, cases, onLink }: { c: MyCase; cases: MyCase[]; onLink: (groupId: string) => void }) {
  const [open, setOpen] = useState(false);
  const mineIds = new Set(cases.map((x) => x.id));
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<button type="button" className="inline-flex h-10 w-fit items-center gap-1.5 rounded-xl px-3.5 text-sm font-bold text-primary ring-1 ring-border transition-colors hover:bg-accent" />}><IconPlus className="size-4" />連結產學組</DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogTitle className="text-lg font-extrabold">連結產學組</DialogTitle>
        <DialogDescription>{c.company}・{c.title}</DialogDescription>
        <ul className="mt-2 flex flex-col gap-2" data-link-options>
          {industryGroups().map((g) => {
            const here = c.groupIds.includes(g.id);
            const other = cases.find((x) => x.id !== c.id && x.groupIds.includes(g.id));
            /* 連到別的老師的合作案：不能動 */
            const foreign = !other && g.industryId && !mineIds.has(g.industryId) ? INDUSTRY.find((i) => i.id === g.industryId) : undefined;
            return (
              <li key={g.id}>
                <button type="button" disabled={here || !!foreign} onClick={() => { onLink(g.id); setOpen(false); }} className="flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left ring-1 ring-border transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:bg-transparent">
                  <span className="min-w-0 flex-1">
                    <span className="tabular block text-[12px] font-bold text-muted-foreground">{g.no}</span>
                    <span className="block truncate text-sm font-bold">{shortTitle(g.title)}</span>
                  </span>
                  <span className="shrink-0 text-[12px] font-bold text-muted-foreground">
                    {here ? <span className="inline-flex items-center gap-1 text-success-on-subtle"><IconCheck className="size-4" />已連結</span> : foreign ? `已連 ${foreign.company.slice(0, 4)}` : other ? `從「${other.title}」改過來` : <IconLink className="size-4 text-primary" />}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
