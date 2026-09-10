import { notFound } from "next/navigation";
import { IconAlertTriangle, IconChecklist, IconLock, IconScale, IconUsers } from "@tabler/icons-react";
import { EmptyState, PageTitle, Panel, Pill, StatTile } from "@/components/dashboard/primitives";
import { HBar, Ring } from "@/components/dashboard/charts";
import { GradingWorkbench } from "@/components/dashboard/grading-workbench";
import { OverrideDialog } from "@/components/dashboard/override-dialog";
import { isValidRole } from "@/lib/nav-config";
import { GRADING_PROGRESS, GRADING_SCHEME, GROUPS } from "@/lib/fixtures";

export default async function GradingPage({ params }: PageProps<"/dashboard/[role]/grading">) {
  const { role } = await params;
  if (!isValidRole(role)) notFound();
  if (role === "student") {
    return (
      <div className="flex flex-col gap-5">
        <PageTitle title="成績" />
        <Panel title="v1 學生看不到成績" icon={<IconLock />}><EmptyState icon={<IconLock />} title="成績只有老師與系辦看得到" hint="規格 §7.6：學生所有頁面與 API 都取得不到分數、評語或排名。" /></Panel>
      </div>
    );
  }
  if (role === "teacher") {
    return (
      <div className="flex flex-col gap-5">
        <PageTitle title="評分工作台" description="只顯示你被指派的組別。暫存只有你看得到，送出後鎖定。" />
        <GradingWorkbench role={role} />
      </div>
    );
  }
  return <AdminGrading role={role} />;
}

/* 管理員：方案、進度、結果 */
function AdminGrading({ role }: { role: string }) {
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
      <PageTitle title="成績管理" description="結構化評分方案；管理員更正保留原值與理由。" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="評分完成" icon={<IconChecklist />} value={`${submitted}/${assigned}`} hint="系統驗收階段" chart={<Ring value={(submitted / assigned) * 100} size={44} stroke={5} color="var(--info)" />} />
        <StatTile label="缺評老師" icon={<IconAlertTriangle />} value={missing.length} unit="位" tone={missing.length ? "warning" : "default"} hint={missing.map((m) => m.teacher).join("、")} />
        <StatTile label="方案版本" icon={<IconScale />} value={`v${scheme.version}`} hint={scheme.locked ? "已鎖定，改結構需新版本" : "可編輯"} tone={scheme.locked ? "default" : "success"} />
        <StatTile label="階段權重" icon={<IconScale />} value={stageOk ? "100%" : "≠100%"} tone={stageOk ? "success" : "danger"} hint={scheme.stages.map((s) => `${s.name} ${s.weight}%`).join("・")} />
      </div>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Panel title="評分方案" icon={<IconScale />} description={`v${scheme.version}・${scheme.locked ? "已鎖定" : "草稿"}`}>
          {scheme.stages.map((st) => {
            const sum = st.items.reduce((a, it) => a + it.weight, 0);
            return (
              <div key={st.id} className="border-b border-border last:border-0">
                <div className="flex items-center justify-between px-5 py-3">
                  <p className="font-bold">{st.name} <span className="ml-1 text-xs font-normal text-muted-foreground">占總成績 {st.weight}%</span></p>
                  {st.items.length ? <Pill tone={sum === 100 ? "success" : "danger"}>項目權重 {sum}%</Pill> : <Pill tone="default">尚未建立項目</Pill>}
                </div>
                {st.items.length ? (
                  <ul className="flex flex-col gap-2 px-5 pb-4">
                    {st.items.map((it) => (
                      <li key={it.id}><HBar label={it.name} value={it.weight} total={100} suffix={`${it.weight}%${it.input === "letter" ? "・A–F" : ""}`} /></li>
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })}
          <p className="px-5 py-3 text-xs text-muted-foreground">最終成績 = Σ（階段成績 × 階段權重）；階段成績為所有正式評分老師的算術平均。</p>
        </Panel>

        <div className="flex flex-col gap-5">
          <Panel title="老師進度" icon={<IconUsers />} description="系統驗收階段">
            <ul className="flex flex-col gap-3 px-5 py-4">
              {GRADING_PROGRESS.map((t) => (
                <li key={t.teacher}><HBar label={t.teacher} value={t.submitted} total={t.assigned} color={t.submitted === t.assigned ? "var(--success)" : t.submitted === 0 ? "var(--destructive)" : "var(--info)"} /></li>
              ))}
            </ul>
          </Panel>
          <Panel title="各組結果" icon={<IconChecklist />} description="平均值在所有正式評分送出後才成立">
            <ul className="divide-y divide-border">
              {results.map((r) => (
                <li key={r.id} className="flex items-center gap-3 px-5 py-3">
                  <span className="tabular w-16 shrink-0 text-xs font-semibold text-muted-foreground">{r.no}</span>
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">{r.title.replace(/（產學：.*）/, "")}</span>
                  <span className="tabular text-xs text-muted-foreground">{r.done}/{r.evaluators} 位送出</span>
                  {r.score !== null ? <span className="tabular w-16 text-right text-lg font-extrabold">{r.score.toFixed(2)}</span> : <span className="w-16 text-right text-xs font-semibold text-muted-foreground">待補</span>}
                  {r.score !== null ? <OverrideDialog groupNo={r.no} original={r.score} /> : <span className="w-14" />}
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}
