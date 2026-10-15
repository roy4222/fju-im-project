"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { IconAlertCircle, IconArrowLeft, IconCircleCheckFilled, IconDownload, IconFileTypePdf, IconMaximize, IconMinus, IconPlayerPlayFilled, IconPlus, IconSchool } from "@tabler/icons-react";
import { saveGradeRecord, stampNow, useGradeRecord } from "@/lib/grading-store";
import { GRADE_STATE_LABEL, GRADING_GROUPS, LETTERS, PASS_LABEL, RUBRIC, SCORE_STEPS, TEACHER_BASE as base, scoreSummary, type Criterion, type GradingGroup, type Scores } from "@/lib/teacher-v2";
import { STATE_CHIP } from "../teacher-grading";

/**
 * 老師：單組評分 v2（Roy 2026-10-15，Q78～Q79；照 grading-mock/grading-group.png、grading-history.png）。
 * 左：這組的作品（報告、附件、影片）；右：固定評分卡（權重、一句說明、依類型的按鈕、評語、即時總分）。
 * 送出後老師自己能改，按「重新送出」；紀錄只留 2～3 行。
 */
export function GradingDesk({ groupId }: { groupId: string }) {
  const router = useRouter();
  const index = GRADING_GROUPS.findIndex((g) => g.groupId === groupId);
  const group = GRADING_GROUPS[index];
  const prev = GRADING_GROUPS[index - 1];
  const next = GRADING_GROUPS[index + 1];
  const rec = useGradeRecord(groupId);
  const [edits, setEdits] = useState<Scores | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const scores = edits ?? rec.scores;
  const sum = scoreSummary(scores);
  const submitted = rec.state === "submitted";
  const changed = edits !== null || !!rec.unsent;

  function set(id: string, patch: { value?: string; comment?: string }) {
    setEdits({ ...scores, [id]: { ...scores[id], ...patch } });
    setFlash(null);
  }

  function saveDraft() {
    saveGradeRecord(groupId, { ...rec, scores, state: submitted ? "submitted" : "draft", unsent: submitted ? true : undefined, lastEdited: stampNow() });
    setEdits(null);
    setFlash("已儲存草稿");
  }

  function send() {
    if (sum.missing) return;
    const at = stampNow();
    const text = rec.log.length ? `修改後重新送出 ${sum.total} 分` : `送出 ${sum.total} 分`;
    saveGradeRecord(groupId, { state: "submitted", scores, lastEdited: at, unsent: false, log: [...rec.log, { at, text }].slice(-3) });
    setEdits(null);
    setFlash(rec.log.length ? "已重新送出" : "已送出");
  }

  /* 換組前有改就先存草稿，不會白填 */
  function go(to: GradingGroup) {
    if (edits) saveDraft();
    router.push(`${base}/grading/${to.groupId}`);
  }

  const lastSent = rec.log[rec.log.length - 1];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <Link href={`${base}/grading`} className="inline-flex items-center gap-1 text-[13px] font-semibold text-muted-foreground transition-colors hover:text-foreground"><IconArrowLeft className="size-4" /> 評分</Link>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <h1 className="text-[24px] leading-tight font-extrabold tracking-tight md:text-[28px]">{group.no}・{group.title}</h1>
            <span className="tabular rounded-full bg-card px-3 py-1 text-sm font-bold ring-1 ring-border" data-position>第 {index + 1}／{GRADING_GROUPS.length} 組</span>
          </div>
        </div>
        <div className="flex gap-2">
          <button type="button" disabled={!prev} onClick={() => prev && go(prev)} className="inline-flex h-10 items-center rounded-xl px-4 text-sm font-bold ring-1 ring-primary/40 transition-colors hover:bg-accent disabled:opacity-40">上一組</button>
          <button type="button" disabled={!next} onClick={() => next && go(next)} className="inline-flex h-10 items-center rounded-xl px-4 text-sm font-bold text-brand-on-subtle ring-1 ring-brand/60 transition-colors hover:bg-brand-subtle disabled:opacity-40">下一組</button>
        </div>
      </div>

      {submitted && lastSent ? (
        <p className="tabular flex flex-wrap items-center gap-2 rounded-2xl bg-success-subtle px-4 py-3 text-sm font-bold text-success-on-subtle" data-sent-banner>
          <IconCircleCheckFilled className="size-5" />
          已送出・{lastSent.at}
          {changed ? <span className="font-semibold text-brand-on-subtle">・有修改還沒重新送出</span> : null}
        </p>
      ) : null}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <WorkPanel group={group} log={rec.log} />

        <aside aria-labelledby="rubric-title" className="dash-card flex flex-col overflow-hidden lg:sticky lg:top-4 lg:max-h-[calc(100svh-6rem)]" data-rubric>
          <div className="flex items-center justify-between border-b border-border/70 px-5 py-4">
            <h2 id="rubric-title" className="text-[17px] font-extrabold">評分規準</h2>
            <span className={`rounded-full px-2.5 py-1 text-[12px] font-bold ${STATE_CHIP[rec.state]}`}>{GRADE_STATE_LABEL[rec.state]}</span>
          </div>
          <ol className="flex flex-col divide-y divide-border/70 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
            {RUBRIC.map((c) => <CriterionRow key={c.id} c={c} value={scores[c.id]?.value} comment={scores[c.id]?.comment} onChange={(p) => set(c.id, p)} />)}
          </ol>
          <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-border/70 bg-card px-5 py-4 lg:static" data-total>
            <div className="mr-auto">
              <p className="tabular text-sm font-bold">總分 <span className="text-[28px] leading-none font-extrabold text-brand">{sum.total}</span> <span className="text-muted-foreground">／100</span></p>
              {sum.missing ? (
                <p className="mt-1 flex items-center gap-1 text-[13px] font-bold text-destructive" data-missing={sum.missing}><IconAlertCircle className="size-4" />還有 {sum.missing} 項沒填</p>
              ) : flash ? (
                <p className="mt-1 text-[13px] font-bold text-success-on-subtle" role="status">{flash}</p>
              ) : null}
            </div>
            <button type="button" onClick={saveDraft} disabled={edits === null} className="inline-flex h-11 items-center rounded-xl px-4 text-sm font-bold text-brand-on-subtle ring-1 ring-brand/60 transition-colors hover:bg-brand-subtle disabled:opacity-40">儲存草稿</button>
            <button type="button" onClick={send} disabled={sum.missing > 0 || (submitted && !changed)} className="inline-flex h-11 items-center rounded-xl bg-brand px-5 text-sm font-bold text-white transition-colors hover:bg-brand/90 disabled:opacity-40">{submitted ? "重新送出" : "正式送出"}</button>
          </div>
        </aside>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- 評分項目 */
function CriterionRow({ c, value, comment, onChange }: { c: Criterion; value?: string; comment?: string; onChange: (p: { value?: string; comment?: string }) => void }) {
  const options = c.kind === "score" ? SCORE_STEPS.map(String) : c.kind === "letter" ? LETTERS.map((l) => l.label) : (["pass", "fail"] as const);
  const custom = c.kind === "score" && value && !SCORE_STEPS.includes(Number(value));
  return (
    <li className="px-5 py-4" data-criterion={c.kind}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[15px] font-extrabold">{c.name}</h3>
        <span className="rounded-full bg-accent px-2 py-0.5 text-[12px] font-bold text-primary">{c.weight ? `占 ${c.weight}%` : "不計分"}</span>
        {!value ? <span aria-hidden className="size-1.5 rounded-full bg-destructive" /> : null}
      </div>
      <p className="mt-0.5 text-[13px] text-muted-foreground">{c.hint}</p>
      <div role="radiogroup" aria-label={c.name} className={`mt-2.5 grid gap-1.5 ${c.kind === "pass" ? "grid-cols-2" : "grid-cols-5"}`}>
        {options.map((o) => {
          const on = value === o;
          const label = c.kind === "pass" ? PASS_LABEL[o as "pass" | "fail"] : o;
          const onCls = c.kind === "pass" ? (o === "pass" ? "bg-success text-success-foreground" : "bg-destructive text-white") : "bg-brand text-white";
          return (
            <button key={o} type="button" role="radio" aria-checked={on} onClick={() => onChange({ value: o })} className={`tabular h-10 rounded-lg text-sm font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-1 focus-visible:outline-ring/40 ${on ? onCls : "bg-card ring-1 ring-border hover:bg-accent"}`}>
              {label}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex gap-2">
        {c.kind === "score" ? (
          <input
            type="number"
            min={0}
            max={100}
            inputMode="numeric"
            aria-label={`${c.name} 分數`}
            placeholder="其他"
            value={custom ? value : ""}
            onChange={(e) => onChange({ value: e.target.value === "" ? undefined : String(Math.min(100, Math.max(0, Number(e.target.value)))) })}
            className={`tabular h-10 w-20 shrink-0 rounded-lg border px-2.5 text-sm font-bold outline-none focus:border-ring focus:ring-3 focus:ring-ring/30 ${custom ? "border-brand bg-brand-subtle" : "border-border bg-card"}`}
          />
        ) : null}
        <input type="text" aria-label={`${c.name} 評語`} placeholder="評語（選填）" value={comment ?? ""} onChange={(e) => onChange({ comment: e.target.value })} className="h-10 min-w-0 flex-1 rounded-lg border border-border bg-muted/40 px-3 text-sm outline-none focus:border-ring focus:bg-card focus:ring-3 focus:ring-ring/30" />
      </div>
    </li>
  );
}

/* ---------------------------------------------------------------- 作品 */
function WorkPanel({ group, log }: { group: GradingGroup; log: { at: string; text: string }[] }) {
  const { report, files, video } = group.work;
  return (
    <section aria-labelledby="work-title" className="dash-card flex flex-col gap-5 p-5" data-work>
      <h2 id="work-title" className="text-[17px] font-extrabold">繳交作品</h2>

      <div className="overflow-hidden rounded-2xl ring-1 ring-border">
        <div className="flex items-center gap-3 border-b border-border bg-card px-3 py-2 text-sm">
          <IconFileTypePdf className="size-5 shrink-0 text-destructive" />
          <span className="min-w-0 flex-1 truncate font-semibold">{report.name}</span>
          <span className="tabular hidden text-muted-foreground sm:inline">1 / {report.pages}</span>
          <span className="hidden items-center gap-1 text-muted-foreground sm:inline-flex"><IconMinus className="size-4" /><span className="tabular text-[13px]">100%</span><IconPlus className="size-4" /></span>
          <a href="#" aria-label="下載報告" className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent"><IconDownload className="size-4" /></a>
          <a href="#" aria-label="全螢幕" className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent"><IconMaximize className="size-4" /></a>
        </div>
        <div className="flex justify-center bg-[oklch(0.42_0.01_253)] px-4 py-6">
          <div className="flex aspect-[3/4] w-full max-w-[17rem] flex-col items-center bg-white px-6 pt-8 pb-5 text-center text-[oklch(0.25_0.05_253)] shadow-lg">
            <p className="text-[17px] leading-snug font-extrabold text-balance">{group.title}</p>
            <p className="mt-1 text-[13px] font-bold">專題成果報告</p>
            <span className="mt-6 inline-flex size-20 items-center justify-center rounded-full bg-[oklch(0.93_0.04_250)] text-[oklch(0.45_0.12_250)]"><IconSchool className="size-10" strokeWidth={1.4} /></span>
            <p className="tabular mt-auto text-[11px] leading-relaxed">輔仁大學資訊管理學系<br />{group.no}・2026 年 10 月</p>
          </div>
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-[15px] font-extrabold">附件</h3>
        <ul className="flex flex-col gap-2">
          {files.map((f) => (
            <li key={f.name}>
              <a href="#" className="flex items-center gap-3 rounded-xl px-3 py-2.5 ring-1 ring-border transition-colors hover:bg-accent">
                <IconFileTypePdf className="size-5 shrink-0 text-destructive" />
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{f.name}<span className="tabular font-normal text-muted-foreground">・{f.size}</span></span>
                <IconDownload className="size-4 text-muted-foreground" />
              </a>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 className="mb-2 text-[15px] font-extrabold">展示影片</h3>
        <a href="#" className="group relative flex aspect-video items-center justify-center overflow-hidden rounded-2xl bg-[linear-gradient(135deg,oklch(0.35_0.09_253),oklch(0.55_0.12_220)_55%,oklch(0.72_0.14_60))]" aria-label={`播放 ${video.title}`}>
          <span className="absolute top-4 left-5 max-w-[60%] text-left text-[17px] leading-snug font-extrabold text-white/95">{video.title}</span>
          <span className="inline-flex h-12 w-16 items-center justify-center rounded-2xl bg-[#ff0033] text-white shadow-lg transition-transform group-hover:scale-105"><IconPlayerPlayFilled className="size-6" /></span>
          <span className="tabular absolute right-3 bottom-3 rounded-md bg-black/70 px-1.5 py-0.5 text-[12px] font-bold text-white">{video.length}</span>
        </a>
      </div>

      {log.length ? (
        <div className="border-t border-border/70 pt-4" data-log>
          <h3 className="mb-1.5 text-[15px] font-extrabold">紀錄</h3>
          <ul className="flex flex-col gap-1 text-sm">
            {log.map((l) => <li key={l.at + l.text} className="tabular flex gap-4"><span className="w-24 shrink-0 text-muted-foreground">{l.at}</span><span className="font-semibold">{l.text}</span></li>)}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
