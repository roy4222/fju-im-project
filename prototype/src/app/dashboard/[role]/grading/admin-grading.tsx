import { IconChecklist, IconScale, IconUsers } from "@tabler/icons-react";
import { PageTitle, Panel, Pill } from "@/components/dashboard/primitives";
import { HBar } from "@/components/dashboard/charts";
import { Bars, StackedRows } from "@/components/dashboard/rc-charts";
import { OverrideDialog } from "@/components/dashboard/override-dialog";
import { GRADING_PROGRESS, GRADING_SCHEME, GROUPS } from "@/lib/fixtures";

/* 管理員（Roy 2026-09-10 選畫布 A）：圖在上（各階段完成率＋老師長條）、表在下（各組結果）、方案放最後 */
export function AdminGrading({ role }: { role: string }) {
  const scheme = GRADING_SCHEME;
  const stageOk = scheme.stages.reduce((a, s) => a + s.weight, 0) === 100;
  const submitted = GRADING_PROGRESS.reduce((a, t) => a + t.submitted, 0);
  const assigned = GRADING_PROGRESS.reduce((a, t) => a + t.assigned, 0);
  const missing = GRADING_PROGRESS.filter((t) => t.submitted < t.assigned);
  // 原型：各組階段成績由固定亂數推出（真實版由 Evaluation 平均）
  const results = GROUPS.map((g, i) => {
    const n = (g.id.charCodeAt(2) * 7 + i * 13) % 30;
    const evaluators = 2;
    const done = i % 3 === 0 ? 1 : 2;
    return { ...g, score: done === evaluators ? 68 + n : null, done, evaluators };
  });
  void role;
  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="成績管理" description={`方案 ${scheme.stages.map((s) => `${s.name} ${s.weight}%`).join(" ＋ ")}・${scheme.locked ? "已鎖定" : "草稿"}`} actions={<button type="button" className="btn-fju h-10 px-4 text-sm">匯出 CSV</button>} />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Panel title="各階段完成率" icon={<IconChecklist />} description="已送出評分份數／應送出">
          <div className="px-5 pb-5"><StackedRows rows={scheme.stages.map((st, i) => ({ label: `${st.name}（${st.weight}%）`, done: i === 0 ? submitted : 0, overdue: 0, total: assigned }))} /></div>
        </Panel>
        <Panel title="老師評分進度" icon={<IconUsers />} description={`系統驗收・${missing.length ? `${missing.map((m) => m.teacher).join("、")} 缺評` : "全部送出"}`}>
          <div className="px-3 pb-3"><Bars height={150} data={GRADING_PROGRESS.map((t) => ({ label: t.teacher, value: t.submitted, hot: t.submitted === t.assigned }))} /></div>
        </Panel>
      </div>
      <Panel title="各組結果" icon={<IconChecklist />} description="平均值在所有正式評分送出後才成立">
        <table className="w-full text-sm">
          <thead><tr className="border-t border-border/70 bg-muted/40 text-left text-[12px] text-muted-foreground"><th className="px-5 py-2.5 font-semibold">組別</th><th className="px-4 py-2.5 font-semibold">題目</th><th className="px-4 py-2.5 font-semibold">狀態</th><th className="px-4 py-2.5 text-right font-semibold">階段成績</th><th className="px-5 py-2.5"></th></tr></thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.id} className="border-t border-border/70 transition-colors hover:[&>td]:bg-accent/40">
                <td className="tabular px-5 py-3 font-bold">{r.no}</td>
                <td className="px-4 py-3 font-semibold">{r.title.replace(/（產學：.*）/, "")}</td>
                <td className="px-4 py-3">{r.score !== null ? <Pill tone="success">已完成</Pill> : r.done ? <Pill tone="brand">{r.done}／{r.evaluators} 位送出</Pill> : <Pill tone="default">未開始</Pill>}</td>
                <td className="tabular px-4 py-3 text-right text-base font-extrabold">{r.score !== null ? r.score.toFixed(2) : <span className="text-sm font-semibold text-muted-foreground">—</span>}</td>
                <td className="px-5 py-3 text-right">{r.score !== null ? <OverrideDialog groupNo={r.no} original={r.score} /> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <Panel title="評分方案" icon={<IconScale />} description={`${scheme.locked ? "已鎖定，改結構需建立新方案" : "可編輯"}・階段權重 ${stageOk ? "合法" : "≠100%"}`}>
        <div className="grid gap-x-8 md:grid-cols-2">
          {scheme.stages.map((st) => {
            const sum = st.items.reduce((a, it) => a + it.weight, 0);
            return (
              <div key={st.id} className="px-5 py-4">
                <div className="flex items-center justify-between"><p className="font-bold">{st.name} <span className="ml-1 text-xs font-normal text-muted-foreground">占總成績 {st.weight}%</span></p>{st.items.length ? <Pill tone={sum === 100 ? "success" : "danger"}>項目 {sum}%</Pill> : <Pill tone="default">尚未建立項目</Pill>}</div>
                {st.items.length ? <ul className="mt-3 flex flex-col gap-2">{st.items.map((it) => <li key={it.id}><HBar label={it.name} value={it.weight} total={100} suffix={`${it.weight}%${it.input === "letter" ? "・A–F" : ""}`} /></li>)}</ul> : null}
              </div>
            );
          })}
        </div>
        <p className="border-t border-border/70 px-5 py-3 text-xs text-muted-foreground">最終成績 = Σ（階段成績 × 階段權重）；階段成績為所有正式評分老師的算術平均。</p>
      </Panel>
    </div>
  );
}
