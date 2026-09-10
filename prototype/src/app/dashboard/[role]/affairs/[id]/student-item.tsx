"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { IconArrowLeft, IconPaperclip, IconUser, IconUsersGroup } from "@tabler/icons-react";
import { GroupForm, type Receipt } from "@/components/dashboard/group-form";
import { FORM_SCHEMAS, SUBMISSION_VERSIONS, formatDue, type ManagedItem, type SubmissionState } from "@/lib/fixtures";
import { DEMO_STAMP_SHORT, fillUnit, groupBlock, itemStatus } from "../student-status";
import { VersionView } from "./version-view";

/**
 * 學生：作業內容／繳交歷史（Roy 2026-09-10：照 TronClass 骨架）。
 * Codex 09-10 S-02／S-03：填寫單位固定在標題下一列；狀態從 student-status 拿，不自己算；
 * 「查看內容」連到 ?tab=history&version=N，顯示當時的欄位值（唯讀）。
 */
export function StudentItem(props: { item: ManagedItem; base: string; tab?: string }) {
  return <Suspense fallback={null}><StudentItemBody {...props} /></Suspense>;
}

function StudentItemBody({ item, base, tab: tabParam }: { item: ManagedItem; base: string; tab?: string }) {
  const sp = useSearchParams();
  const versionParam = Number(sp.get("version"));
  const fields = FORM_SCHEMAS[item.id] ?? [];
  const versions = SUBMISSION_VERSIONS[item.id] ?? [];
  /* 送出後同一頁的橫幅、按鈕文字跟著變（本地 state 就好） */
  const [local, setLocal] = useState<{ state: SubmissionState; receipt: Receipt } | null>(null);
  const s = itemStatus(item, local?.state);
  const lastBy = local?.receipt.by ?? s.lastBy;
  const lastAt = local?.receipt.at ?? s.lastAt;
  const version = local?.receipt.version ?? s.version;
  const unit = fillUnit(item, local ? DEMO_STAMP_SHORT : undefined);
  const block = item.form === "group" ? groupBlock() : null;
  const tab = tabParam === "history" ? "history" : "content";
  const locked = !s.editable;

  const banner = s.overdue
    ? { tone: "danger", text: `逾期未繳（${s.detail.replace("・需系辦重開", "")}）。需要補交請聯絡系辦重新開放。` }
    : s.submitted
      ? { tone: "success", text: `已繳 v${version}・${lastBy} 於 ${lastAt} 送出・${s.editable ? "截止前可重送，以最後一次為準" : "截止後唯讀"}。` }
      : { tone: s.state === "draft" ? "brand" : "info", text: `${s.headline}・${s.detail}${item.dueAt ? `・${formatDue(item.dueAt)}截止` : ""}${block ? `・${block.text}` : ""}` };
  const BANNER: Record<string, string> = { danger: "bg-destructive-subtle text-destructive-on-subtle", success: "bg-success-subtle text-success-on-subtle", brand: "bg-brand-subtle text-brand-on-subtle", info: "bg-info-subtle text-info-on-subtle" };
  const info: [string, string][] = [
    ["截止時間", item.dueAt ? `${item.dueAt} 23:59` : "無"],
    ["階段", item.stage ?? "未指定"],
    ["附件", item.attachments ? `${item.attachments} 個` : "無"],
    ["重送", s.editable ? "截止前可重送" : "截止後唯讀"],
  ];
  const cta = s.submitted ? (s.editable ? "重送" : null) : s.action;

  return (
    <div className="flex flex-col gap-5">
      <Link href={`${base}/affairs`} className="inline-flex w-fit items-center gap-1 text-[13px] font-semibold text-muted-foreground transition-colors hover:text-foreground"><IconArrowLeft className="size-4" /> 作業區</Link>
      <div className="dash-card overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-3 px-6 pt-5 pb-3">
          <div className="min-w-0">
            <h1 className="text-[22px] font-extrabold tracking-tight">{item.title}</h1>
            <p className="mt-1 flex items-start gap-1.5 text-[13px] text-muted-foreground">
              {unit.group ? <IconUsersGroup className="mt-0.5 size-4 shrink-0 text-primary" /> : <IconUser className="mt-0.5 size-4 shrink-0 text-primary" />}
              <span className="tabular">{unit.text}</span>
            </p>
          </div>
          {cta && tab === "content" ? <a href="#submit" className="btn-fju h-11 rounded-lg px-5 text-sm">{cta}</a> : null}
        </div>
        <div className={`mx-6 mb-4 rounded-lg px-4 py-3 text-sm font-semibold ${BANNER[banner.tone]}`}>{banner.text}</div>
        <nav className="flex gap-1 border-b border-border px-4" aria-label="作業分頁">
          {[["content", "作業內容"], ["history", `繳交歷史${versions.length ? `（${versions.length}）` : ""}`]].map(([k, l]) => (
            <Link key={k} href={`${base}/affairs/${item.id}${k === "history" ? "?tab=history" : ""}`} className={`-mb-px inline-flex h-11 items-center border-b-2 px-4 text-sm font-semibold transition-colors ${tab === k ? "border-brand text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>{l}</Link>
          ))}
        </nav>
        {tab === "content" ? (
          <div className="flex flex-col gap-6 p-6">
            <dl className="grid gap-x-8 gap-y-2 border-b border-border pb-4 text-sm sm:grid-cols-2">
              {info.map(([k, v]) => <div key={k} className="flex gap-4"><dt className="w-16 shrink-0 text-muted-foreground">{k}</dt><dd className="tabular font-semibold">{v}</dd></div>)}
            </dl>
            <section>
              <h2 className="mb-2 text-[15px] font-bold">作業說明</h2>
              <p className="text-sm leading-7">{item.summary}</p>
              {item.attachments ? <ul className="mt-3 flex flex-col gap-1.5">{Array.from({ length: item.attachments }, (_, i) => <li key={i}><a href="#" className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:text-brand"><IconPaperclip className="size-4" />附件 {i + 1}.pdf</a></li>)}</ul> : null}
            </section>
            <section id="submit" className="scroll-mt-4">
              <h2 className="mb-3 text-[15px] font-bold">{locked ? "已截止・唯讀" : s.submitted ? "重送" : "填寫與繳交"}</h2>
              <GroupForm
                fields={fields}
                state={s.state}
                locked={locked}
                backHref={`${base}/affairs`}
                itemTitle={item.title}
                blocked={block?.text ?? null}
                blockedHref={block ? `${base}/groups` : undefined}
                onSubmitted={(receipt) => setLocal({ state: "submitted", receipt })}
              />
            </section>
          </div>
        ) : versionParam > 0 ? (
          <VersionView item={item} version={versionParam} base={base} />
        ) : (
          <div className="p-6">
            {versions.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">還沒有送出過。</p>
            ) : (
              <table className="w-full text-sm">
                <thead><tr className="text-left text-[12px] text-muted-foreground"><th className="py-2 font-semibold">第幾次</th><th className="py-2 font-semibold">送出者</th><th className="py-2 font-semibold">時間</th><th className="hidden py-2 font-semibold sm:table-cell">備註</th><th className="py-2"></th></tr></thead>
                <tbody>
                  {versions.map((v, i) => (
                    <tr key={v.version} className="border-t border-border/70">
                      <td className="tabular py-3 font-semibold">第 {v.version} 次{i === 0 ? <span className="ml-2 rounded-full bg-success-subtle px-2 py-0.5 text-[11px] text-success-on-subtle">採計</span> : null}</td>
                      <td className="py-3">{v.by}</td>
                      <td className="tabular py-3 text-muted-foreground">{v.at}</td>
                      <td className="hidden py-3 text-muted-foreground sm:table-cell">{v.note ?? "—"}</td>
                      <td className="py-1 text-right"><Link href={`${base}/affairs/${item.id}?tab=history&version=${v.version}`} className="inline-flex h-10 items-center rounded-lg px-3 text-[13px] font-semibold text-primary transition-colors hover:bg-accent">查看內容</Link></td>
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
