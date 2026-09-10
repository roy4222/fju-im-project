import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { IconArrowLeft, IconClock, IconFileText, IconInfoCircle, IconPaperclip, IconUsersGroup } from "@tabler/icons-react";
import { buttonVariants } from "@/components/ui/button";
import { PageTitle, Panel, Pill, StateBadge } from "@/components/dashboard/primitives";
import { Ring, SegmentBar } from "@/components/dashboard/charts";
import { GroupForm } from "@/components/dashboard/group-form";
import { ReopenDialog } from "@/components/dashboard/reopen-dialog";
import { isValidRole } from "@/lib/nav-config";
import { CURRENT_USERS, FORM_SCHEMAS, GROUPS, GROUP_SUBMISSIONS, MANAGED_ITEMS, PLACEMENT_LABEL, SUBMISSION_VERSIONS, daysUntil, formatDue } from "@/lib/fixtures";

export default async function AffairItemPage({ params, searchParams }: PageProps<"/dashboard/[role]/affairs/[id]">) {
  const { role, id } = await params;
  const sp = await searchParams;
  if (!isValidRole(role)) notFound();
  const item = MANAGED_ITEMS.find((i) => i.id === id);
  if (!item) notFound();
  const base = `/dashboard/${role}`;
  const fields = FORM_SCHEMAS[item.id] ?? [];
  const rows = GROUP_SUBMISSIONS[item.id] ?? [];
  const versions = SUBMISSION_VERSIONS[item.id] ?? [];
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

  /* ---------------- 學生：作業內容／繳交歷史（Roy 2026-09-10：照 TronClass 骨架） */
  if (role === "student") {
    const state = item.myState ?? "todo";
    const locked = state === "overdue" || state === "locked";
    const submitted = state === "submitted" || state === "locked";
    const tab = sp.tab === "history" ? "history" : "content";
    const last = versions[0];
    const banner = state === "overdue"
      ? { tone: "danger", text: `已逾期 ${Math.abs(due!)} 天，無法繳交。需要補交請聯絡系辦重新開放。` }
      : submitted
        ? { tone: "success", text: `已繳交（${last?.by ?? "組員"} 於 ${last?.at ?? ""} 送出）${state === "locked" ? "，已截止鎖定" : "，截止前可重送，以最後一次為準"}。` }
        : state === "draft"
          ? { tone: "brand", text: `草稿尚未送出。${item.dueAt ? `${formatDue(item.dueAt)}截止` : ""}，任一組員送出即代表全組完成。` }
          : { tone: "info", text: `尚未繳交。${item.dueAt ? `${formatDue(item.dueAt)}截止，` : ""}${item.form === "personal" ? "每位同學各自填寫。" : "整組共用一份，任一組員送出即代表全組完成。"}` };
    const BANNER: Record<string, string> = { danger: "bg-destructive-subtle text-destructive-on-subtle", success: "bg-success-subtle text-success-on-subtle", brand: "bg-brand-subtle text-brand-on-subtle", info: "bg-info-subtle text-info-on-subtle" };
    const info: [string, ReactNode][] = [
      ["截止時間", item.dueAt ? `${item.dueAt} 23:59` : "無"],
      ["作業形式", item.form === "personal" ? "個人填報" : "組別繳交"],
      ["階段", item.stage ?? "未指定"],
      ["附件", item.attachments ? `${item.attachments} 個` : "無"],
      ["完成指標", "送出表單"],
      ["重送", locked ? "已關閉" : "截止前可重送"],
    ];
    return (
      <div className="flex flex-col gap-5">
        <Link href={`${base}/affairs`} className="inline-flex w-fit items-center gap-1 text-[13px] font-semibold text-muted-foreground transition-colors hover:text-foreground"><IconArrowLeft className="size-4" /> 作業區</Link>
        <div className="dash-card overflow-hidden">
          <div className="flex flex-wrap items-start justify-between gap-3 px-6 pt-5 pb-4">
            <h1 className="text-[22px] font-extrabold tracking-tight">{item.title}</h1>
            {!locked ? <a href="#submit" className="btn-fju h-10 rounded-xl px-5 text-sm">{submitted ? "重送" : state === "draft" ? "繼續填寫" : "去繳交"}</a> : null}
          </div>
          <div className={`mx-6 mb-4 flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold ${BANNER[banner.tone]}`}><IconInfoCircle className="size-4 shrink-0" />{banner.text}</div>
          <nav className="flex gap-1 border-b border-border px-4" aria-label="作業分頁">
            {[["content", "作業內容"], ["history", `繳交歷史${versions.length ? `（${versions.length}）` : ""}`]].map(([k, l]) => (
              <Link key={k} href={`${base}/affairs/${item.id}${k === "history" ? "?tab=history" : ""}`} className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors ${tab === k ? "border-brand text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>{l}</Link>
            ))}
          </nav>
          {tab === "content" ? (
            <div className="flex flex-col gap-6 p-6">
              <dl className="grid gap-x-8 gap-y-3 rounded-xl bg-muted/40 p-5 text-sm sm:grid-cols-2">
                {info.map(([k, v]) => <div key={k} className="flex gap-4"><dt className="w-20 shrink-0 text-muted-foreground">{k}</dt><dd className="tabular font-semibold">{v}</dd></div>)}
              </dl>
              <section>
                <h2 className="mb-2 inline-block border-b-2 border-brand pb-1 text-[15px] font-bold">作業說明</h2>
                <p className="text-sm leading-7">{item.summary}</p>
                {item.attachments ? <ul className="mt-3 flex flex-col gap-1.5">{Array.from({ length: item.attachments }, (_, i) => <li key={i}><a href="#" className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:text-brand"><IconPaperclip className="size-4" />附件 {i + 1}.pdf</a></li>)}</ul> : null}
              </section>
              <section id="submit">
                <h2 className="mb-3 inline-block border-b-2 border-brand pb-1 text-[15px] font-bold">{locked ? "已截止" : submitted ? "重送" : "填寫與繳交"}</h2>
                <GroupForm fields={fields} state={state} locked={locked} backHref={`${base}/affairs`} itemTitle={item.title} />
              </section>
            </div>
          ) : (
            <div className="p-6">
              {versions.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">還沒有送出過。</p>
              ) : (
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-[12px] text-muted-foreground"><th className="py-2 font-semibold">第幾次</th><th className="py-2 font-semibold">送出者</th><th className="py-2 font-semibold">時間</th><th className="py-2 font-semibold">備註</th><th className="py-2"></th></tr></thead>
                  <tbody>
                    {versions.map((v, i) => (
                      <tr key={v.version} className="border-t border-border/70">
                        <td className="tabular py-3 font-semibold">第 {v.version} 次{i === 0 ? <span className="ml-2 rounded-full bg-success-subtle px-2 py-0.5 text-[11px] text-success-on-subtle">採計</span> : null}</td>
                        <td className="py-3">{v.by}</td>
                        <td className="tabular py-3 text-muted-foreground">{v.at}</td>
                        <td className="py-3 text-muted-foreground">{v.note ?? "—"}</td>
                        <td className="py-3 text-right"><a href="#" className="text-[13px] font-semibold text-primary hover:text-brand">查看內容</a></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ---------------- 老師／管理員：各組狀態 */
  const me = CURRENT_USERS.teacher;
  const groups = role === "teacher" ? GROUPS.filter((g) => g.advisorId === me.id) : GROUPS;
  const focus = typeof sp.group === "string" ? sp.group : undefined;
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
