import Link from "next/link";
import { IconChecklist, IconHandGrab, IconSignature } from "@tabler/icons-react";
import { buttonVariants } from "@/components/ui/button";
import { Panel, Pill } from "@/components/dashboard/primitives";
import { Donut } from "@/components/dashboard/rc-charts";
import { Spot, TintCard, type HomeModel } from "@/components/dashboard/home-widgets";
import { CURRENT_USERS, EVALUATION_QUEUE, GROUPS, INDUSTRY, SIGNOFF, SIGNOFF_PROGRESS, currentStage, type Role } from "@/lib/fixtures";

export function teacherHome(role: Role): HomeModel {
  const base = `/dashboard/${role}`;
  const me = CURRENT_USERS.teacher;
  const myGroups = GROUPS.filter((g) => g.advisorId === me.id);
  const claimable = GROUPS.filter((g) => g.type === "INDUSTRY" && g.advisorId === null);
  const pending = EVALUATION_QUEUE.filter((e) => e.state === "pending");
  const staged = EVALUATION_QUEUE.filter((e) => e.state === "staged");
  const submittedQ = EVALUATION_QUEUE.filter((e) => e.state === "submitted");
  const teacherSign = SIGNOFF_PROGRESS.filter((s) => s.students === s.total && !s.teacher && myGroups.some((g) => g.id === s.groupId));
  const myCases = INDUSTRY.filter((i) => i.advisorName === me.name);
  const stage = currentStage();
  const gradingPct = Math.round((submittedQ.length / EVALUATION_QUEUE.length) * 100);

  return {
    role,
    layout: "teacher",
    name: `${me.name} 老師`,
    line: pending.length ? `現在是「${stage.title}」。系統驗收評分送出 ${submittedQ.length}/${EVALUATION_QUEUE.length} 組，還有 ${pending.length} 組沒開始。` : `現在是「${stage.title}」。評分都送出了。`,
    cta: pending.length ? { href: `${base}/grading`, label: "去評分" } : undefined,
    heroIllustration: <Spot icon={<IconChecklist className="size-20" strokeWidth={1.4} />} size={168} className="tint tint-sky" />,
    chips: [
      { label: "待評分", value: `${pending.length} 組`, href: `${base}/grading`, hot: pending.length > 0 },
      { label: "待我同意", value: `${teacherSign.length} 件`, href: `${base}/signoff`, hot: teacherSign.length > 0 },
      { label: "指導組別", value: `${myGroups.length} 組`, href: `${base}/groups` },
    ],
    /* 右上：評分進度（Minuto 的「今日目標」位置） */
    aside: (
      <Panel title="評分進度" description="系統驗收・占總成績 60%" className="h-full">
        <div className="flex items-center gap-5 px-5 pt-1 pb-4">
          <Donut size={116} thickness={14} data={[{ name: "已送出", value: submittedQ.length, color: "var(--success)" }, { name: "已暫存", value: staged.length, color: "var(--brand)" }, { name: "未開始", value: pending.length, color: "var(--border)" }]} center={<span className="text-center"><span className="tabular block text-[22px] font-extrabold leading-none">{gradingPct}%</span><span className="text-[10px] text-muted-foreground">已送出</span></span>} />
          <ul className="flex flex-1 flex-col gap-2 text-sm">
            <li className="flex items-center justify-between"><span className="inline-flex items-center gap-2"><span className="size-2 rounded-full bg-success" />已送出</span><b className="tabular">{submittedQ.length}</b></li>
            <li className="flex items-center justify-between"><span className="inline-flex items-center gap-2"><span className="size-2 rounded-full bg-brand" />已暫存</span><b className="tabular">{staged.length}</b></li>
            <li className="flex items-center justify-between"><span className="inline-flex items-center gap-2"><span className="size-2 rounded-full bg-border" />未開始</span><b className="tabular">{pending.length}</b></li>
          </ul>
        </div>
        <div className="border-t border-border/70 px-5 py-3 text-xs text-muted-foreground">送出後鎖定；要改請系辦退回。</div>
      </Panel>
    ),
    stats: [],
    modules: [
      {
        key: "grading", present: EVALUATION_QUEUE.length > 0, span: 2,
        node: (
          <Panel title="評分工作台" description="系統驗收" action={{ href: `${base}/grading`, label: "開啟" }} className="h-full">
            <ul className="flex flex-col gap-1 px-3 pb-3">
              {EVALUATION_QUEUE.map((e) => (
                <li key={e.groupId}>
                  <Link href={`${base}/grading/${e.groupId}`} className="dash-card-hover flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-accent/40">
                    <span className="tabular w-14 shrink-0 text-xs font-semibold text-muted-foreground">{e.groupNo}</span>
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold">{e.title}</span>
                    {e.state === "pending" ? <Pill tone="brand">未開始</Pill> : e.state === "staged" ? <Pill tone="default">已暫存</Pill> : <Pill tone="success">已送出</Pill>}
                    <span className={buttonVariants({ size: "sm", variant: e.state === "submitted" ? "outline" : "default", className: "press rounded-lg" })}>{e.state === "pending" ? "開始" : e.state === "staged" ? "繼續" : "查看"}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        ),
      },
      {
        key: "claim", present: claimable.length > 0,
        node: (
          <TintCard tint="mint" title="可認領產學組" description="先按先得" action={{ href: `${base}/groups`, label: "全部" }} illustration={<Spot icon={<IconHandGrab className="size-9" strokeWidth={1.5} />} size={72} />}>
            <ul className="px-3 pt-2 pb-3">
              {claimable.map((g) => (
                <li key={g.id} className="flex items-center gap-3 rounded-xl px-2 py-2"><span className="tabular shrink-0 text-xs font-semibold text-muted-foreground">{g.no}</span><span className="min-w-0 flex-1 truncate text-sm font-semibold">{g.title.replace(/（產學：.*）/, "")}</span><Link href={`${base}/groups`} className={buttonVariants({ size: "sm", variant: "outline", className: "press rounded-lg bg-card" })}>認領</Link></li>
              ))}
            </ul>
          </TintCard>
        ),
      },
      {
        key: "sign", present: teacherSign.length > 0,
        node: (
          <TintCard tint="lilac" title="待我同意" description="學生已全數同意" action={{ href: `${base}/signoff`, label: "進度" }} illustration={<Spot icon={<IconSignature className="size-9" strokeWidth={1.5} />} size={72} />}>
            <ul className="px-3 pt-2 pb-3">
              {teacherSign.map((s) => (
                <li key={s.groupId} className="flex items-center gap-3 rounded-xl px-2 py-2"><span className="tabular shrink-0 text-xs font-semibold text-muted-foreground">{s.groupNo}</span><span className="min-w-0 flex-1 truncate text-sm font-semibold">{SIGNOFF.title}</span><Link href={`${base}/signoff`} className="btn-fju h-8 rounded-lg px-3 text-xs">同意</Link></li>
              ))}
            </ul>
          </TintCard>
        ),
      },
      {
        key: "groups", present: myGroups.length > 0,
        node: (
          <Panel title="指導組別" description={`${myGroups.length} 組`} action={{ href: `${base}/groups`, label: "總覽" }} className="h-full">
            <ul className="flex flex-col px-5 pb-4">
              {myGroups.map((g) => (
                <li key={g.id} className="flex items-center gap-3 border-t border-border/70 py-2.5 text-sm first:border-t-0">
                  <span className="tabular w-14 shrink-0 text-xs font-semibold text-muted-foreground">{g.no}</span>
                  <span className="min-w-0 flex-1 truncate font-semibold">{g.title.replace(/（產學：.*）/, "")}</span>
                  {g.type === "INDUSTRY" ? <Pill tone="info">產學</Pill> : null}
                </li>
              ))}
            </ul>
          </Panel>
        ),
      },
      {
        key: "industry", present: myCases.length > 0,
        node: (
          <Panel title="我的合作案" description={`${myCases.length} 件`} action={{ href: `${base}/industry`, label: "管理" }} className="h-full">
            <ul className="px-5 pb-4">
              {myCases.map((c) => (
                <li key={c.id} className="flex items-center gap-3 border-t border-border/70 py-2.5 first:border-t-0"><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{c.company}</span><span className="block truncate text-xs text-muted-foreground">{c.title}</span></span>{c.status === "claimed" ? <Pill tone="default">已有 {c.linkedGroups} 組</Pill> : <Pill tone="brand">尚未指派</Pill>}</li>
              ))}
            </ul>
          </Panel>
        ),
      },
    ],
  };
}
