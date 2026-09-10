import Link from "next/link";
import type { ReactNode } from "react";
import { IconArrowLeft, IconInfoCircle, IconPaperclip } from "@tabler/icons-react";
import { GroupForm } from "@/components/dashboard/group-form";
import { FORM_SCHEMAS, SUBMISSION_VERSIONS, daysUntil, formatDue, type ManagedItem } from "@/lib/fixtures";

/** 學生：作業內容／繳交歷史（Roy 2026-09-10：照 TronClass 骨架） */
export function StudentItem({ item, base, tab: tabParam }: { item: ManagedItem; base: string; tab?: string }) {
  const fields = FORM_SCHEMAS[item.id] ?? [];
  const versions = SUBMISSION_VERSIONS[item.id] ?? [];
  const due = item.dueAt ? daysUntil(item.dueAt) : null;
  const sp = { tab: tabParam };
  /* ---------------- 學生：作業內容／繳交歷史（Roy 2026-09-10：照 TronClass 骨架） */
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
