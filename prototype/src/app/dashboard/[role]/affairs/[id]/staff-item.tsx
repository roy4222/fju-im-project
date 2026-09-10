import Link from "next/link";
import { IconArrowLeft, IconClock, IconFileText, IconPaperclip, IconUsersGroup } from "@tabler/icons-react";
import { buttonVariants } from "@/components/ui/button";
import { PageTitle, Panel, Pill, StateBadge } from "@/components/dashboard/primitives";
import { Ring, SegmentBar } from "@/components/dashboard/charts";
import { ReopenDialog } from "@/components/dashboard/reopen-dialog";
import { CURRENT_USERS, FORM_SCHEMAS, GROUPS, GROUP_SUBMISSIONS, PLACEMENT_LABEL, daysUntil, formatDue, type ManagedItem, type Role } from "@/lib/fixtures";

/** 老師／管理員：各組狀態、收件進度、欄位 */
export function StaffItem({ item, role, base, focus }: { item: ManagedItem; role: Role; base: string; focus?: string }) {
  const fields = FORM_SCHEMAS[item.id] ?? [];
  const rows = GROUP_SUBMISSIONS[item.id] ?? [];
  const due = item.dueAt ? daysUntil(item.dueAt) : null;
  const header = (
    <div className="flex flex-col gap-3">
      <Link href={`${base}/affairs`} className="inline-flex w-fit items-center gap-1 text-[13px] font-semibold text-muted-foreground transition-colors hover:text-foreground"><IconArrowLeft className="size-4" /> 專題事務</Link>
      <PageTitle
        title={item.title}
        description={item.summary}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone="default">{PLACEMENT_LABEL[item.placement]}</Pill>
            {item.dueAt ? <Pill tone={due! < 0 ? "danger" : due! <= 10 ? "brand" : "default"}><IconClock className="mr-1 size-3" />{formatDue(item.dueAt)}・{item.dueAt}</Pill> : null}
            {item.schemaVersion ? <Pill tone="info">v{item.schemaVersion}</Pill> : null}
            {role === "admin" ? <Link href={`${base}/editor/${item.id}`} className={buttonVariants({ size: "lg", className: "press rounded-lg" })}>編輯內容</Link> : null}
          </div>
        }
      />
    </div>
  );
  /* ---------------- 老師／管理員：各組狀態 */
  const me = CURRENT_USERS.teacher;
  const groups = role === "teacher" ? GROUPS.filter((g) => g.advisorId === me.id) : GROUPS;
  const done = rows.filter((r) => r.state === "submitted").length;
  const overdue = rows.filter((r) => r.state === "overdue").length;
  return (
    <div className="flex flex-col gap-5">
      {header}
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <Panel title={role === "teacher" ? "我的指導組別" : "各組狀態"} icon={<IconUsersGroup />} description={`${groups.length} 組`}>
          <ul className="divide-y divide-border">
            {groups.map((g) => {
              const r = rows.find((x) => x.groupId === g.id);
              return (
                <li key={g.id} className={`flex flex-wrap items-center gap-3 px-5 py-3.5 transition-colors ${focus === g.id ? "bg-brand-subtle/40" : ""}`}>
                  <span className="tabular w-16 shrink-0 text-xs font-semibold text-muted-foreground">{g.no}</span>
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">{g.title.replace(/（產學：.*）/, "")}</span>
                  <StateBadge state={r?.state ?? "todo"} />
                  {r?.at ? <span className="tabular text-xs text-muted-foreground">v{r.version}・{r.submittedBy}・{r.at.slice(5)}</span> : <span className="text-xs text-muted-foreground">—</span>}
                  {r?.state === "submitted" ? <button type="button" className={buttonVariants({ size: "sm", variant: "outline", className: "press rounded-lg" })}><IconPaperclip /> 檢視</button> : null}
                  {role === "admin" && (r?.state === "overdue" || r?.state === "todo") ? <ReopenDialog groupNo={g.no} itemTitle={item.title} /> : null}
                </li>
              );
            })}
          </ul>
        </Panel>
        <div className="flex flex-col gap-5">
          <Panel title="收件進度" icon={<IconFileText />}>
            <div className="flex items-center gap-5 px-5 py-4">
              <Ring value={rows.length ? (done / rows.length) * 100 : 0} size={84} stroke={9} color="var(--success)">
                <span className="tabular text-base font-extrabold">{rows.length ? Math.round((done / rows.length) * 100) : 0}%</span>
              </Ring>
              <dl className="grid flex-1 grid-cols-1 gap-1.5 text-sm">
                <div className="flex justify-between"><dt className="text-muted-foreground">已繳</dt><dd className="tabular font-semibold">{done}</dd></div>
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
