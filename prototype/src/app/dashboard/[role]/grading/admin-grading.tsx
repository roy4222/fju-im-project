import { IconChecklist, IconScale, IconUsers } from "@tabler/icons-react";
import { PageTitle, Panel, Pill } from "@/components/dashboard/primitives";
import { HBar } from "@/components/dashboard/charts";
import { Bars, StackedRows } from "@/components/dashboard/rc-charts";
import { OverrideDialog } from "@/components/dashboard/override-dialog";
import { RegradeDialog } from "@/components/dashboard/regrade-dialog";
import { RemindDialog } from "@/components/dashboard/remind-dialog";
import { SchemeDialog } from "@/components/dashboard/scheme-dialog";
import { GRADING_PROGRESS, GRADING_SCHEME, GROUPS, TEACHERS } from "@/lib/fixtures";

/**
 * 管理員成績（Roy 2026-09-10 選畫布 A）：圖在上、表在下、方案最後。
 * Codex 09-10 A-04：表格與 dialog 用同一種標籤（「系統驗收 階段成績」），更正可選評審或平均，補退回重評與建立新方案。
 */
export function AdminGrading({ role }: { role: string }) {
  const scheme = GRADING_SCHEME;
  const stage = scheme.stages[0];
  const stageOk = scheme.stages.reduce((a, s) => a + s.weight, 0) === 100;
  const submitted = GRADING_PROGRESS.reduce((a, t) => a + t.submitted, 0);
  const assigned = GRADING_PROGRESS.reduce((a, t) => a + t.assigned, 0);
  const missing = GRADING_PROGRESS.filter((t) => t.submitted < t.assigned);
  // 原型：每組 2 位評審、分數由固定算式推出（真實版由 Evaluation 平均）
  const results = GROUPS.map((g, i) => {
    const n = (g.id.charCodeAt(2) * 7 + i * 13) % 30;
    const names = [TEACHERS[i % 4].name, TEACHERS[(i + 2) % 4].name];
    const done = i % 3 === 0 ? 1 : 2;
    const evaluators = names.map((name, k) => ({ name, score: k < done ? Math.round((68 + n + (k ? 3 : -3)) * 100) / 100 : null }));
    const complete = done === evaluators.length;
    const avg = complete ? evaluators.reduce((a, e) => a + (e.score ?? 0), 0) / evaluators.length : null;
    return { ...g, evaluators, done, avg };
  });
  void role;
  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="成績管理" description={`方案 v${scheme.version}・${scheme.stages.map((s) => `${s.name} ${s.weight}%`).join(" ＋ ")}・${scheme.locked ? "已鎖定" : "草稿"}。現在評「${stage.name}」。`} actions={<SchemeDialog />} />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Panel title="各階段完成率" icon={<IconChecklist />} description="已送出評分份數／應送出">
          <div className="px-5 pb-5"><StackedRows rows={scheme.stages.map((st, i) => ({ label: `${st.name}（${st.weight}%）`, done: i === 0 ? submitted : 0, overdue: 0, total: assigned }))} /></div>
        </Panel>
        <Panel title="老師評分進度" icon={<IconUsers />} description={`${stage.name}・${submitted}／${assigned} 份`} action={<RemindDialog recipients={missing.map((m) => ({ name: m.teacher, detail: `${m.submitted}／${m.assigned} 組・${TEACHERS.find((t) => t.name === m.teacher)?.email ?? ""}` }))} subject={`【專題】${stage.name}評分尚未送齊`} context={`${missing.length} 位老師還有組別沒送出。`} label={`催繳缺評（${missing.length}）`} />}>
          <div className="px-3 pb-3"><Bars height={150} data={GRADING_PROGRESS.map((t) => ({ label: t.teacher, value: t.submitted, hot: t.submitted === t.assigned }))} /></div>
        </Panel>
      </div>
      <Panel title={`各組 ${stage.name} 階段成績`} icon={<IconChecklist />} description="兩位評審都送出後才有階段平均；更正與退回都留紀錄">
        <table className="w-full text-sm">
          <thead><tr className="border-t border-border/70 bg-muted/40 text-left text-[12px] text-muted-foreground"><th className="px-5 py-2.5 font-semibold">組別</th><th className="px-4 py-2.5 font-semibold">題目</th><th className="px-4 py-2.5 font-semibold">評審</th><th className="px-4 py-2.5 font-semibold">狀態</th><th className="px-4 py-2.5 text-right font-semibold">{stage.name} 階段成績</th><th className="px-5 py-2.5"></th></tr></thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.id} className="border-t border-border/70 transition-colors hover:[&>td]:bg-accent/40">
                <td className="tabular px-5 py-3 font-bold">{r.no}</td>
                <td className="px-4 py-3 font-semibold">{r.title.replace(/（產學：.*）/, "")}</td>
                <td className="px-4 py-3"><ul className="flex flex-col gap-0.5 text-xs">{r.evaluators.map((e) => <li key={e.name} className="flex items-center gap-2"><span className={e.score === null ? "text-muted-foreground" : ""}>{e.name}</span><span className="tabular font-semibold">{e.score === null ? "未送出" : e.score.toFixed(2)}</span></li>)}</ul></td>
                <td className="px-4 py-3">{r.avg !== null ? <Pill tone="success">已完成</Pill> : r.done ? <Pill tone="brand">{r.done}／{r.evaluators.length} 位送出</Pill> : <Pill tone="default">未開始</Pill>}</td>
                <td className="tabular px-4 py-3 text-right text-base font-extrabold">{r.avg !== null ? r.avg.toFixed(2) : <span className="text-sm font-semibold text-muted-foreground">—</span>}</td>
                <td className="px-5 py-3 text-right"><span className="inline-flex gap-1">{r.avg !== null ? <OverrideDialog groupNo={r.no} stageName={stage.name} evaluators={r.evaluators.map((e) => ({ name: e.name, score: e.score! }))} average={r.avg} /> : null}<RegradeDialog groupNo={r.no} stageName={stage.name} evaluators={r.evaluators} /></span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <Panel title={`評分方案 v${scheme.version}`} icon={<IconScale />} description={`${scheme.locked ? "已鎖定，改結構請建立新方案版本" : "可編輯"}・階段權重 ${stageOk ? "合法" : "≠100%"}`}>
        <div className="grid gap-x-8 md:grid-cols-2">
          {scheme.stages.map((st) => {
            const sum = st.items.reduce((a, it) => a + it.weight, 0);
            return (
              <div key={st.id} className="px-5 py-4">
                <div className="flex items-center justify-between"><p className="font-bold">{st.name} <span className="ml-1 text-xs font-normal text-muted-foreground">占總成績 {st.weight}%</span></p>{st.items.length ? <Pill tone={sum === 100 ? "success" : "danger"}>項目 {sum}%</Pill> : <Pill tone="default">尚未建立項目</Pill>}</div>
                {st.items.length ? <ul className="mt-3 flex flex-col gap-2">{st.items.map((it) => <li key={it.id}><HBar label={it.name} value={it.weight} total={100} suffix={`${it.weight}%${it.input === "letter" ? "・A–F" : ""}`} /></li>)}</ul> : <p className="mt-2 text-sm text-muted-foreground">用右上「建立新方案版本」補上項目與評審。</p>}
              </div>
            );
          })}
        </div>
        <p className="border-t border-border/70 px-5 py-3 text-xs text-muted-foreground">最終成績 = Σ（階段成績 × 階段權重）；階段成績為兩位評審的算術平均。</p>
      </Panel>
    </div>
  );
}
