"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { IconArrowLeft, IconCheck, IconClock, IconFileText, IconMail, IconUsersGroup, IconX } from "@tabler/icons-react";
import { buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { PageTitle, Panel, Pill, StateBadge } from "@/components/dashboard/primitives";
import { Ring, SegmentBar } from "@/components/dashboard/charts";
import { ReopenDialog } from "@/components/dashboard/reopen-dialog";
import { SubmissionViewDialog } from "@/components/dashboard/submission-view-dialog";
import { CURRENT_USERS, FORM_SCHEMAS, GROUPS, GROUP_SUBMISSIONS, PLACEMENT_LABEL, TEACHERS, daysUntil, formatDue, isSubmittedState, type Group, type GroupSubmission, type ManagedItem, type Role } from "@/lib/fixtures";

type Filter = "missing" | "overdue" | null;
const FILTER_LABEL: Record<Exclude<Filter, null>, string> = { missing: "未繳", overdue: "逾期" };

/**
 * 老師／管理員：各組狀態、收件進度、欄位。
 * Codex 09-10 A-04／A-05：已繳「檢視」開內容 dialog；重開後列表即時變；?filter=missing|overdue 只顯示對應組並有可移除標籤；
 * 已繳一律用 isSubmittedState()（locked 算已繳），列表與明細口徑相同。
 */
export function StaffItem({ item, role, base, focus }: { item: ManagedItem; role: Role; base: string; focus?: string }) {
  const sp = useSearchParams();
  const urlFilter = sp.get("filter");
  const [filter, setFilter] = useState<Filter>(urlFilter === "missing" || urlFilter === "overdue" ? urlFilter : null);
  const [reopened, setReopened] = useState<Record<string, string>>({});
  const fields = FORM_SCHEMAS[item.id] ?? [];
  const rows = GROUP_SUBMISSIONS[item.id] ?? [];
  const due = item.dueAt ? daysUntil(item.dueAt) : null;
  const me = CURRENT_USERS.teacher;
  const groups = role === "teacher" ? GROUPS.filter((g) => g.advisorId === me.id) : GROUPS;
  const rowOf = (g: Group): GroupSubmission => rows.find((x) => x.groupId === g.id) ?? { groupId: g.id, state: "todo" };
  const done = rows.filter((r) => isSubmittedState(r.state)).length;
  const overdue = rows.filter((r) => r.state === "overdue").length;
  const missingGroups = groups.filter((g) => !isSubmittedState(rowOf(g).state));
  const shown = groups.filter((g) => {
    const r = rowOf(g);
    if (filter === "missing") return !isSubmittedState(r.state);
    if (filter === "overdue") return r.state === "overdue";
    return true;
  });
  const advisorName = (g: Group) => TEACHERS.find((t) => t.id === g.advisorId)?.name;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <Link href={`${base}/affairs`} className="inline-flex w-fit items-center gap-1 text-[13px] font-semibold text-muted-foreground transition-colors hover:text-foreground"><IconArrowLeft className="size-4" /> 專題事務</Link>
        <div>
          <p className="text-xs font-semibold text-muted-foreground">{PLACEMENT_LABEL[item.placement]}{item.form === "group" ? "・整組一份" : ""}{item.stage ? `・${item.stage}階段` : ""}</p>
          <PageTitle
            title={item.title}
            description={item.summary}
            actions={
              <div className="flex flex-wrap items-center gap-2">
                {item.dueAt ? <Pill tone={due! < 0 ? "danger" : due! <= 10 ? "brand" : "default"}><IconClock className="mr-1 size-3" />{formatDue(item.dueAt)}・{item.dueAt}</Pill> : null}
                {item.schemaVersion ? <Pill tone="default">欄位 v{item.schemaVersion}</Pill> : null}
                {role === "admin" ? <RemindDialog item={item} groups={missingGroups} advisorName={advisorName} /> : null}
                {role === "admin" ? <Link href={`${base}/editor/${item.id}`} className={buttonVariants({ size: "lg", className: "press rounded-lg" })}>編輯內容</Link> : null}
              </div>
            }
          />
        </div>
      </div>
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <Panel
          title={role === "teacher" ? "我的指導組別" : "各組狀態"}
          icon={<IconUsersGroup />}
          description={filter ? `${shown.length}／${groups.length} 組` : `${groups.length} 組`}
          action={
            filter ? (
              <button type="button" onClick={() => setFilter(null)} className="inline-flex h-8 items-center gap-1 rounded-full border border-brand/30 bg-brand-subtle px-3 text-xs font-semibold text-brand-on-subtle" aria-label={`移除篩選：${FILTER_LABEL[filter]}`}>
                {FILTER_LABEL[filter]} {shown.length} 組 <IconX className="size-3.5" />
              </button>
            ) : (
              <div className="flex gap-1.5">
                <button type="button" onClick={() => setFilter("missing")} className="h-8 rounded-full border border-border px-3 text-xs font-semibold text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground">未繳 {missingGroups.length}</button>
                <button type="button" onClick={() => setFilter("overdue")} className="h-8 rounded-full border border-border px-3 text-xs font-semibold text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground">逾期 {overdue}</button>
              </div>
            )
          }
        >
          <ul className="divide-y divide-border">
            {shown.map((g) => {
              const r = rowOf(g);
              const re = reopened[g.id];
              const notify = [...g.members.map((m) => m.name), ...(advisorName(g) ? [`${advisorName(g)}（指導老師）`] : [])];
              const reopen = role === "admin" && (r.state === "overdue" || r.state === "todo" || r.state === "locked" || r.state === "draft") && !re ? (
                <ReopenDialog groupNo={g.no} itemTitle={item.title} originalDue={item.dueAt} currentVersion={isSubmittedState(r.state) ? r.version : undefined} notify={notify} onDone={(d) => setReopened((x) => ({ ...x, [g.id]: d }))} />
              ) : null;
              return (
                <li key={g.id} className={`flex flex-wrap items-center gap-3 px-5 py-3 transition-colors hover:bg-accent/40 ${focus === g.id ? "bg-brand-subtle/40" : ""}`}>
                  <span className="tabular w-16 shrink-0 text-xs font-semibold text-muted-foreground">{g.no}</span>
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">{g.title.replace(/（產學：.*）/, "")}</span>
                  {re ? <Pill tone="brand">已重開至 {re.slice(5)}</Pill> : <StateBadge state={r.state} />}
                  {r.at ? <span className="tabular text-xs text-muted-foreground">v{r.version}・{r.submittedBy}・{r.at.slice(5)}</span> : <span className="text-xs text-muted-foreground">—</span>}
                  {isSubmittedState(r.state) ? <SubmissionViewDialog item={item} group={g} row={r} fields={fields}>{reopen}</SubmissionViewDialog> : null}
                  {!isSubmittedState(r.state) ? reopen : null}
                </li>
              );
            })}
            {shown.length === 0 ? <li className="px-5 py-8 text-center text-sm text-muted-foreground">沒有{filter ? FILTER_LABEL[filter] : ""}的組別。</li> : null}
          </ul>
        </Panel>
        <div className="flex flex-col gap-5">
          <Panel title="收件進度" icon={<IconFileText />} description={`${rows.length} 組`}>
            <div className="flex items-center gap-5 px-5 py-4">
              <Ring value={rows.length ? (done / rows.length) * 100 : 0} size={84} stroke={9} color="var(--success)">
                <span className="tabular text-base font-extrabold">{rows.length ? Math.round((done / rows.length) * 100) : 0}%</span>
              </Ring>
              <dl className="grid flex-1 grid-cols-1 gap-1.5 text-sm">
                <div className="flex justify-between"><dt className="text-muted-foreground">已繳（含鎖定）</dt><dd className="tabular font-semibold">{done}</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">逾期</dt><dd className="tabular font-semibold text-destructive">{overdue}</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">未繳</dt><dd className="tabular font-semibold">{rows.length - done - overdue}</dd></div>
              </dl>
            </div>
            <div className="px-5 pb-4"><SegmentBar segments={[{ value: done, color: "var(--success)", label: "已繳" }, { value: overdue, color: "var(--destructive)", label: "逾期" }, { value: rows.length - done - overdue, color: "var(--muted)", label: "未繳" }]} /></div>
          </Panel>
          <Panel title="欄位" icon={<IconFileText />} description={`${fields.length} 個・版本 ${item.schemaVersion ?? 1}`}>
            <ul className="flex flex-col gap-1 px-5 py-3 text-sm">
              {fields.filter((f) => !["heading", "paragraph", "divider", "groupinfo"].includes(f.type)).map((f) => (
                <li key={f.id} className="flex items-center justify-between gap-2 py-1"><span className="truncate">{f.label}</span>{f.required ? <span className="text-[11px] text-destructive">必填</span> : null}</li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}

/** 催繳：先看寄給誰、信件標題，確認後回饋「已排入寄送（原型不寄信）」 */
function RemindDialog({ item, groups, advisorName }: { item: ManagedItem; groups: Group[]; advisorName: (g: Group) => string | undefined }) {
  const [done, setDone] = useState(false);
  const recipients = groups.reduce((a, g) => a + g.members.length, 0);
  const advisors = [...new Set(groups.map(advisorName).filter(Boolean))] as string[];
  return (
    <Dialog onOpenChange={(o) => !o && setDone(false)}>
      <DialogTrigger render={<button type="button" disabled={groups.length === 0} className={buttonVariants({ size: "lg", variant: "outline", className: "press rounded-lg" })} />}>
        <IconMail /> 催繳{groups.length ? `（${groups.length} 組）` : ""}
      </DialogTrigger>
      <DialogContent className="max-w-md">
        {done ? (
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="inline-flex size-12 items-center justify-center rounded-full bg-success-subtle text-success-on-subtle"><IconCheck className="size-6" /></span>
            <DialogTitle className="text-lg font-extrabold">已排入寄送</DialogTitle>
            <DialogDescription>{groups.length} 組、{recipients} 位學生{advisors.length ? `，副本 ${advisors.length} 位指導老師` : ""}。原型不寄信；正式版寄出後會寫入操作紀錄。</DialogDescription>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div>
              <DialogTitle className="text-lg font-extrabold">催繳 {groups.length} 組</DialogTitle>
              <DialogDescription className="mt-1">{item.title}{item.dueAt ? `・${item.dueAt} 截止` : ""}</DialogDescription>
            </div>
            <div className="rounded-lg bg-muted px-4 py-3 text-sm">
              <p className="text-xs font-bold text-muted-foreground">信件標題</p>
              <p className="mt-1 font-semibold">［專題事務］{item.title} 尚未繳交，請於 {item.dueAt ?? "期限"} 前完成</p>
            </div>
            <div>
              <p className="text-xs font-bold text-muted-foreground">寄給 {recipients} 位學生{advisors.length ? `，副本：${advisors.join("、")}` : ""}</p>
              <ul className="mt-2 max-h-48 divide-y divide-border overflow-y-auto rounded-lg border border-border text-sm">
                {groups.map((g) => <li key={g.id} className="flex items-center gap-3 px-3 py-2"><span className="tabular w-16 shrink-0 font-semibold">{g.no}</span><span className="min-w-0 flex-1 truncate text-muted-foreground">{g.members.map((m) => m.name).join("、")}</span></li>)}
              </ul>
            </div>
            <button type="button" onClick={() => setDone(true)} className="btn-fju h-10 text-sm">確認寄出</button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
