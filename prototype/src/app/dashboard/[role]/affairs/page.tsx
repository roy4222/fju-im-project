import Link from "next/link";
import { notFound } from "next/navigation";
import { IconClipboardText, IconClock, IconPaperclip, IconUser, IconUsersGroup } from "@tabler/icons-react";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState, PageTitle, Panel, Pill, ProgressBar, StatTile } from "@/components/dashboard/primitives";
import { Ring, SegmentBar } from "@/components/dashboard/charts";
import { PillLink } from "@/components/public/pill-link";
import { isValidRole } from "@/lib/nav-config";
import { TeacherMatrix } from "./teacher-matrix";
import { NewItemDialog } from "@/components/dashboard/new-item-dialog";
import { CURRENT_USERS, GROUPS, MANAGED_ITEMS, PLACEMENT_LABEL, SUBMISSION_VERSIONS, daysUntil, formatDue, type Placement, type Role } from "@/lib/fixtures";

export default async function AffairsPage({ params, searchParams }: PageProps<"/dashboard/[role]/affairs">) {
  const { role } = await params;
  const sp = await searchParams;
  if (!isValidRole(role)) notFound();
  if (role === "student") return <StudentAffairs role={role} tab={typeof sp.tab === "string" ? sp.tab : "all"} />;
  if (role === "teacher") return <TeacherAffairs role={role} />;
  return <AdminAffairs role={role} placement={typeof sp.placement === "string" ? sp.placement : "all"} />;
}

/* ---------------------------------------------------------------- 學生：作業區 */
/**
 * Roy 2026-09-10：照 TronClass 作業區的骨架——一列一件、欄位是「作業名稱／形式／狀態／截止」，
 * 日期不放左邊大字，繳交才是重點；點進去看內容、繳交歷史、去繳交。學生 v1 看不到成績，沒有成績欄。
 */
const TABS = [
  { key: "all", label: "全部", filter: () => true },
  { key: "open", label: "待繳", filter: (s: string) => s === "todo" || s === "draft" || s === "resubmit" },
  { key: "done", label: "已繳交", filter: (s: string) => s === "submitted" || s === "locked" },
  { key: "overdue", label: "已逾期", filter: (s: string) => s === "overdue" },
] as const;
const FORM_LABEL = { group: "組別繳交", personal: "個人填報" } as const;
const STATE_WORD: Record<string, { text: string; cls: string }> = {
  todo: { text: "未繳", cls: "text-muted-foreground" },
  draft: { text: "草稿", cls: "text-brand" },
  resubmit: { text: "需重送", cls: "text-brand" },
  submitted: { text: "已繳", cls: "text-success" },
  locked: { text: "已繳", cls: "text-success" },
  overdue: { text: "逾期未繳", cls: "text-destructive" },
};

function StudentAffairs({ role, tab = "all" }: { role: Role; tab?: string }) {
  const base = `/dashboard/${role}`;
  const all = MANAGED_ITEMS.filter((i) => i.myState).sort((a, b) => daysUntil(a.dueAt ?? "2099-01-01") - daysUntil(b.dueAt ?? "2099-01-01"));
  const active = TABS.find((t) => t.key === tab) ?? TABS[0];
  const list = all.filter((i) => active.filter(i.myState!));
  const count = (k: string) => all.filter((i) => TABS.find((t) => t.key === k)!.filter(i.myState!)).length;
  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="作業區" description={`第 07 組。待繳 ${count("open")}・已繳交 ${count("done")}・逾期 ${count("overdue")}`} />
      <Panel
        title={active.label}
        description={`${list.length} 件・依截止日排序`}
        action={
          <div className="flex gap-1.5">
            {TABS.map((t) => <PillLink key={t.key} href={`${base}/affairs${t.key === "all" ? "" : `?tab=${t.key}`}`} active={t.key === active.key}>{t.label}</PillLink>)}
          </div>
        }
      >
        {list.length === 0 ? (
          <EmptyState title={`沒有${active.label}的作業`} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-t border-border/70 bg-muted/40 text-left text-[12px] text-muted-foreground">
                  <th className="px-5 py-2.5 font-semibold">作業名稱</th>
                  <th className="px-4 py-2.5 font-semibold">形式</th>
                  <th className="px-4 py-2.5 font-semibold">狀態</th>
                  <th className="px-4 py-2.5 font-semibold">截止</th>
                  <th className="px-5 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {list.map((item) => {
                  const state = item.myState!;
                  const d = item.dueAt ? daysUntil(item.dueAt) : null;
                  const submitted = state === "submitted" || state === "locked";
                  const closed = state === "overdue" || state === "locked";
                  const versions = SUBMISSION_VERSIONS[item.id] ?? [];
                  const last = versions[0];
                  const word = STATE_WORD[state];
                  return (
                    <tr key={item.id} className="group border-t border-border/70 transition-colors hover:[&>td]:bg-accent/40">
                      <td className="px-5 py-3.5 first:rounded-l-lg">
                        <Link href={`${base}/affairs/${item.id}`} className="block">
                          <span className="block text-[15px] font-bold group-hover:text-primary">{item.title}</span>
                          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                            <span className={`font-semibold ${closed ? "text-foreground" : "text-success"}`}>{closed ? "已結束" : "進行中"}</span>
                            <span>階段：{item.stage ?? "未指定"}</span>
                            {item.attachments ? <span className="inline-flex items-center gap-1"><IconPaperclip className="size-3.5" />{item.attachments} 個附件</span> : null}
                          </span>
                        </Link>
                      </td>
                      <td className="px-4 py-3.5 whitespace-nowrap"><span className="inline-flex items-center gap-1.5">{item.form === "personal" ? <IconUser className="size-4 text-primary" /> : <IconUsersGroup className="size-4 text-primary" />}{FORM_LABEL[item.form ?? "group"]}</span></td>
                      <td className={`px-4 py-3.5 whitespace-nowrap font-semibold ${word.cls}`}>
                        {word.text}
                        {submitted && last ? <span className="tabular block text-[11px] font-normal text-muted-foreground">{last.by}・{last.at.slice(5, 16)}</span> : null}
                      </td>
                      <td className="tabular px-4 py-3.5 whitespace-nowrap">
                        {item.dueAt ? <><span className="block">{item.dueAt.slice(5).replace("-", "/")} 23:59</span><span className={`block text-[11px] ${state === "overdue" ? "text-destructive" : !submitted && d! <= 10 ? "font-semibold text-brand" : "text-muted-foreground"}`}>{state === "overdue" ? `逾期 ${Math.abs(d!)} 天` : submitted ? "已送出" : formatDue(item.dueAt)}</span></> : <span className="text-muted-foreground">無截止</span>}
                      </td>
                      <td className="px-5 py-3.5 text-right last:rounded-r-lg">
                        <Link href={`${base}/affairs/${item.id}`} className={buttonVariants({ size: "sm", variant: state === "draft" || state === "todo" || state === "resubmit" ? "default" : "outline", className: "press rounded-lg" })}>
                          {state === "draft" ? "繼續填寫" : state === "todo" ? "去繳交" : state === "resubmit" ? "重送" : "查看"}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

/* ---------------------------------------------------------------- 老師 */
function TeacherAffairs({ role }: { role: Role }) {
  const base = `/dashboard/${role}`;
  const me = CURRENT_USERS.teacher;
  const myGroups = GROUPS.filter((g) => g.advisorId === me.id);
  const items = MANAGED_ITEMS.filter((i) => i.progress);
  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="各組繳交狀態" description={`我的 ${myGroups.length} 個指導組別 × ${items.length} 個收件項目`} />
      <Panel title="繳交矩陣" icon={<IconClipboardText />} description="點狀態看版本與內容" bodyClassName="p-4">
        <TeacherMatrix groups={myGroups} items={items} base={base} />
      </Panel>
    </div>
  );
}

/* ---------------------------------------------------------------- 管理員 */
function AdminAffairs({ role, placement }: { role: Role; placement: string }) {
  const base = `/dashboard/${role}`;
  const all = MANAGED_ITEMS;
  const items = placement === "all" ? all : all.filter((i) => i.placement === placement);
  const placements = [...new Set(all.map((i) => i.placement))] as Placement[];
  const published = all.filter((i) => i.status === "published").length;
  const totalDone = all.reduce((a, i) => a + (i.progress?.done ?? 0), 0);
  const totalAll = all.reduce((a, i) => a + (i.progress?.total ?? 0), 0);
  const overdue = all.reduce((a, i) => a + (i.progress?.overdue ?? 0), 0);
  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="專題事務工作台" description="公告、資源、文件繳交、專題需求共用同一個編輯器與生命週期。" actions={<NewItemDialog base={base} />} />
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile label="發布中" value={published} unit="項" hint={`共 ${all.length} 項`} chart={<Ring value={(published / all.length) * 100} size={44} stroke={5} />} />
        <StatTile label="整體收件" value={`${totalDone}/${totalAll}`} tone="success" chart={<Ring value={(totalDone / totalAll) * 100} size={44} stroke={5} color="var(--success)" />} />
        <StatTile label="逾期組別" value={overdue} unit="組" tone={overdue ? "danger" : "default"} hint="需個別重新開放" chart={<Ring value={(overdue / totalAll) * 100} size={44} stroke={5} color="var(--destructive)" />} />
      </div>
      <Panel
        title="全部項目"
        icon={<IconClipboardText />}
        action={
          <nav className="flex flex-wrap gap-1.5" aria-label="發布位置">
            <PillLink href={`${base}/affairs`} active={placement === "all"}>全部</PillLink>
            {placements.map((p) => (
              <PillLink key={p} href={`${base}/affairs?placement=${p}`} active={placement === p}>{PLACEMENT_LABEL[p]}</PillLink>
            ))}
          </nav>
        }
      >
        <ul className="divide-y divide-border">
          {items.map((i) => (
            <li key={i.id} className="grid items-center gap-3 px-5 py-3.5 md:grid-cols-[minmax(0,1.5fr)_10rem_14rem_auto]">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Pill tone="default">{PLACEMENT_LABEL[i.placement]}</Pill>
                  <Pill tone={i.status === "published" ? "success" : i.status === "draft" ? "info" : "default"}>{i.status === "published" ? "發布中" : i.status === "draft" ? "草稿" : "已下架"}</Pill>
                  {i.schemaVersion ? <span className="tabular text-[11px] text-muted-foreground">v{i.schemaVersion}</span> : null}
                </div>
                <Link href={`${base}/affairs/${i.id}`} className="link-ink mt-1 block truncate text-[15px] font-bold">{i.title}</Link>
                <p className="truncate text-xs text-muted-foreground">{i.audience}</p>
              </div>
              <div className="text-xs text-muted-foreground">
                {i.dueAt ? <span className={`tabular inline-flex items-center gap-1 font-semibold ${daysUntil(i.dueAt) < 0 ? "text-destructive" : "text-foreground"}`}><IconClock className="size-3.5" />{i.dueAt}</span> : <span>無截止</span>}
              </div>
              <div>{i.progress ? <ProgressBar done={i.progress.done} total={i.progress.total} overdue={i.progress.overdue} /> : <span className="text-xs text-muted-foreground">不收件</span>}</div>
              <div className="flex gap-2">
                <Link href={`${base}/affairs/${i.id}`} className={buttonVariants({ size: "sm", variant: "outline", className: "press rounded-lg" })}>狀態</Link>
                <Link href={`${base}/editor/${i.id}`} className={buttonVariants({ size: "sm", className: "press rounded-lg" })}>編輯</Link>
              </div>
            </li>
          ))}
        </ul>
        {items.length === 0 ? <EmptyState title="這個位置沒有項目" /> : null}
      </Panel>
      {placement === "all" ? (
        <Panel title="各位置收件概況" icon={<IconClipboardText />}>
          <ul className="grid gap-4 p-5 md:grid-cols-2">
            {all.filter((i) => i.progress).map((i) => (
              <li key={i.id} className="flex flex-col gap-2">
                <div className="flex items-center justify-between text-sm"><span className="truncate font-semibold">{i.title}</span><span className="tabular text-xs text-muted-foreground">{i.progress!.done}/{i.progress!.total}</span></div>
                <SegmentBar segments={[{ value: i.progress!.done, color: "var(--success)", label: "已繳" }, { value: i.progress!.overdue, color: "var(--destructive)", label: "逾期" }, { value: i.progress!.total - i.progress!.done - i.progress!.overdue, color: "var(--muted)", label: "未繳" }]} />
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}
