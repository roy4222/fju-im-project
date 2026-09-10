import Link from "next/link";
import { IconPaperclip, IconUser, IconUsersGroup } from "@tabler/icons-react";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState, PageTitle, Panel } from "@/components/dashboard/primitives";
import { PillLink } from "@/components/public/pill-link";
import { MANAGED_ITEMS, SUBMISSION_VERSIONS, daysUntil, formatDue, type Role } from "@/lib/fixtures";

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

export function StudentAffairs({ role, tab = "all" }: { role: Role; tab?: string }) {
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
