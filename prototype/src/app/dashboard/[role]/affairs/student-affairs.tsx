import Link from "next/link";
import { IconPaperclip, IconUser, IconUsersGroup } from "@tabler/icons-react";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState, PageTitle, Panel } from "@/components/dashboard/primitives";
import { MANAGED_ITEMS, MY_GROUP, daysUntil, formatDue, isSubmittedState, studentOpenItems, type ManagedItem, type Role } from "@/lib/fixtures";
import { TONE_CLS, itemStatus } from "./student-status";

/* ---------------------------------------------------------------- 學生：作業區 */
/**
 * Roy 2026-09-10：照 TronClass 作業區的骨架——一列一件、欄位是「作業名稱／形式／狀態／截止」。
 * Codex 09-10 S-03／S-05：狀態拆成「已繳 v2／截止後唯讀」兩行；手機（<640px）一件一張卡；篩選單行可橫滑。
 * 數字口徑：待繳＝studentOpenItems()（與側欄徽章、首頁 chip 同一個函式）。
 */
const FORM_LABEL = { group: "整組一份", personal: "個人一份" } as const;

export function StudentAffairs({ role, tab = "all" }: { role: Role; tab?: string }) {
  const base = `/dashboard/${role}`;
  const all = MANAGED_ITEMS.filter((i) => i.myState).sort((a, b) => daysUntil(a.dueAt ?? "2099-01-01") - daysUntil(b.dueAt ?? "2099-01-01"));
  const openIds = new Set(studentOpenItems().map((i) => i.id));
  const TABS = [
    { key: "all", label: "全部", filter: (i: ManagedItem) => !!i.myState },
    { key: "open", label: "待繳", filter: (i: ManagedItem) => openIds.has(i.id) },
    { key: "done", label: "已繳交", filter: (i: ManagedItem) => isSubmittedState(i.myState) },
    { key: "overdue", label: "逾期未繳", filter: (i: ManagedItem) => itemStatus(i).overdue },
  ];
  const active = TABS.find((t) => t.key === tab) ?? TABS[0];
  const list = all.filter(active.filter);
  const count = (k: string) => all.filter(TABS.find((t) => t.key === k)!.filter).length;

  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="作業區" description={`${MY_GROUP.no}・待繳 ${count("open")}・已繳交 ${count("done")}${count("overdue") ? `・逾期未繳 ${count("overdue")}` : ""}`} />
      <Panel title={active.label} description={`${list.length} 件・依截止日排序`}>
        <div className="-mx-1 flex gap-1.5 overflow-x-auto border-b border-border/70 px-5 pb-3 [scrollbar-width:none]" role="tablist" aria-label="篩選">
          {TABS.map((t) => {
            const on = t.key === active.key;
            return (
              <Link key={t.key} role="tab" aria-selected={on} href={`${base}/affairs${t.key === "all" ? "" : `?tab=${t.key}`}`} scroll={false} className={`inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full border px-4 text-sm font-semibold whitespace-nowrap transition-colors ${on ? "border-primary bg-primary text-primary-foreground" : "border-border text-foreground hover:bg-accent"}`}>
                {t.label}<span className={`tabular text-xs ${on ? "text-primary-foreground/80" : "text-muted-foreground"}`}>{count(t.key)}</span>
              </Link>
            );
          })}
        </div>
        {list.length === 0 ? (
          <EmptyState title={`沒有${active.label}的作業`} />
        ) : (
          <>
            {/* 手機：一件一列的卡片 */}
            <ul className="divide-y divide-border/70 sm:hidden">
              {list.map((item) => {
                const s = itemStatus(item);
                return (
                  <li key={item.id} className="flex flex-col gap-2 px-5 py-4">
                    <Link href={`${base}/affairs/${item.id}`} className="text-[15px] font-bold">{item.title}</Link>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
                      <span className={`font-semibold ${TONE_CLS[s.headlineTone]}`}>{s.headline}</span>
                      <span className="text-muted-foreground">{s.detail}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="tabular min-w-0 flex-1 text-[13px] text-muted-foreground">{item.dueAt ? <>{item.dueAt.slice(5).replace("-", "/")} 截止{!s.submitted && !s.overdue ? `・${formatDue(item.dueAt)}` : ""}</> : "無截止"}・{FORM_LABEL[item.form ?? "group"]}</span>
                      <Link href={`${base}/affairs/${item.id}`} className={openIds.has(item.id) ? "btn-fju h-11 shrink-0 rounded-lg px-4 text-sm" : buttonVariants({ variant: "outline", className: "press h-11 shrink-0 rounded-lg px-4 text-sm" })}>{s.action}</Link>
                    </div>
                  </li>
                );
              })}
            </ul>
            {/* 桌面：表格 */}
            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="bg-muted/40 text-left text-[12px] text-muted-foreground">
                    <th className="px-5 py-2.5 font-semibold">作業名稱</th>
                    <th className="px-4 py-2.5 font-semibold">形式</th>
                    <th className="px-4 py-2.5 font-semibold">狀態</th>
                    <th className="px-4 py-2.5 font-semibold">截止</th>
                    <th className="px-5 py-2.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((item) => {
                    const s = itemStatus(item);
                    const d = item.dueAt ? daysUntil(item.dueAt) : null;
                    return (
                      <tr key={item.id} className="border-t border-border/70 transition-colors hover:bg-accent/40">
                        <td className="px-5 py-3.5">
                          <Link href={`${base}/affairs/${item.id}`} className="block">
                            <span className="block text-[15px] font-bold">{item.title}</span>
                            <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                              <span>階段：{item.stage ?? "未指定"}</span>
                              {item.attachments ? <span className="inline-flex items-center gap-1"><IconPaperclip className="size-3.5" />{item.attachments} 個附件</span> : null}
                            </span>
                          </Link>
                        </td>
                        <td className="px-4 py-3.5 whitespace-nowrap"><span className="inline-flex items-center gap-1.5">{item.form === "personal" ? <IconUser className="size-4 text-primary" /> : <IconUsersGroup className="size-4 text-primary" />}{FORM_LABEL[item.form ?? "group"]}</span></td>
                        <td className="px-4 py-3.5 whitespace-nowrap">
                          <span className={`block font-semibold ${TONE_CLS[s.headlineTone]}`}>{s.headline}</span>
                          <span className="block text-[12px] text-muted-foreground">{s.detail}{s.submitted && s.lastBy ? <span className="tabular">・{s.lastBy} {s.lastAt?.slice(5, 16)}</span> : null}</span>
                        </td>
                        <td className="tabular px-4 py-3.5 whitespace-nowrap">
                          {item.dueAt ? <><span className="block">{item.dueAt.slice(5).replace("-", "/")} 23:59</span><span className={`block text-[12px] ${s.overdue ? "text-destructive" : !s.submitted && d! <= 10 ? "font-semibold text-brand-on-subtle" : "text-muted-foreground"}`}>{s.overdue ? `逾期 ${Math.abs(d!)} 天` : s.submitted ? (s.editable ? `剩 ${d} 天可重送` : "已截止") : formatDue(item.dueAt)}</span></> : <span className="text-muted-foreground">無截止</span>}
                        </td>
                        <td className="px-5 py-3.5 text-right">
                          <Link href={`${base}/affairs/${item.id}`} className={openIds.has(item.id) ? "btn-fju h-10 rounded-lg px-4 text-sm" : buttonVariants({ variant: "outline", className: "press h-10 rounded-lg px-4 text-sm" })}>{s.action}</Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Panel>
    </div>
  );
}
