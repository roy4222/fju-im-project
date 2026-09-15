import Link from "next/link";
import { IconChecklist, IconHandGrab, IconSignature } from "@tabler/icons-react";
import { buttonVariants } from "@/components/ui/button";
import { Panel, Pill } from "@/components/dashboard/primitives";
import { Donut } from "@/components/dashboard/rc-charts";
import { Spot, TintCard, type HomeModel } from "@/components/dashboard/home-widgets";
import { CURRENT_USERS, EVALUATION_QUEUE, GROUPS, INDUSTRY, SIGNOFF, currentStage, teacherGradingCounts, teacherGroups, teacherSignReady, teacherSignWaiting, type Role } from "@/lib/fixtures";

/** 老師首頁：快捷摘要，數字全部用 fixtures 的共用函式（T-04），不重做一套隊列。 */
export function teacherHome(role: Role): HomeModel {
  const base = `/dashboard/${role}`;
  const me = CURRENT_USERS.teacher;
  const myGroups = teacherGroups();
  const claimable = GROUPS.filter((g) => g.type === "INDUSTRY" && g.advisorId === null);
  const counts = teacherGradingCounts();
  const ready = teacherSignReady();
  const waiting = teacherSignWaiting();
  const myCases = INDUSTRY.filter((i) => i.advisorName === me.name);
  const openAll = INDUSTRY.filter((i) => i.status === "open").length;
  const stage = currentStage();

  return {
    role,
    layout: "teacher",
    name: `${me.name} 老師`,
    line: counts.remaining ? `現在是「${stage.title}」。系統驗收還有 ${counts.remaining} 組沒正式送出：未開始 ${counts.pending}、草稿 ${counts.staged}。` : `現在是「${stage.title}」。系統驗收評分都送出了。`,
    cta: counts.remaining ? { href: `${base}/grading`, label: `繼續評分（${counts.remaining} 組）` } : undefined,
    heroIllustration: <Spot icon={<IconChecklist className="size-20" strokeWidth={1.4} />} size={168} className="tint tint-sky" />,
    chips: [
      { label: "未開始", value: `${counts.pending} 組`, href: `${base}/grading` },
      { label: "草稿", value: `${counts.staged} 組`, href: `${base}/grading` },
      { label: "已送出", value: `${counts.submitted} 組`, href: `${base}/grading` },
      { label: "待我同意", value: `${ready.length} 組`, href: `${base}/signoff`, hot: ready.length > 0 },
    ],
    /* 右上：評分進度 */
    aside: (
      <Panel title="評分進度" description="系統驗收・占總成績 60%" className="h-full">
        <div className="flex items-center gap-5 px-5 pt-1 pb-4">
          <Donut size={116} thickness={14} data={[{ name: "已送出", value: counts.submitted, color: "var(--success)" }, { name: "草稿", value: counts.staged, color: "var(--brand)" }, { name: "未開始", value: counts.pending, color: "var(--border)" }]} center={<span className="text-center"><span className="tabular block text-[22px] font-extrabold leading-none">{counts.submitted}/{counts.total}</span><span className="text-[10px] text-muted-foreground">已送出</span></span>} />
          <ul className="flex flex-1 flex-col gap-2 text-sm">
            <li className="flex items-center justify-between"><span className="inline-flex items-center gap-2"><span className="size-2 rounded-full bg-success" />已送出</span><b className="tabular">{counts.submitted}</b></li>
            <li className="flex items-center justify-between"><span className="inline-flex items-center gap-2"><span className="size-2 rounded-full bg-brand" />草稿</span><b className="tabular">{counts.staged}</b></li>
            <li className="flex items-center justify-between"><span className="inline-flex items-center gap-2"><span className="size-2 rounded-full bg-border" />未開始</span><b className="tabular">{counts.pending}</b></li>
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
          <Panel title="評分工作台" description={`系統驗收・還有 ${counts.remaining} 組`} action={{ href: `${base}/grading`, label: "開啟" }} className="h-full">
            <ul className="flex flex-col px-5 pb-3">
              {EVALUATION_QUEUE.map((e) => (
                <li key={e.groupId}>
                  <Link href={`${base}/grading/${e.groupId}`} className="flex min-h-11 items-center gap-3 border-t border-border/70 py-2.5 transition-colors hover:bg-accent/40">
                    <span className="tabular w-14 shrink-0 text-xs font-semibold text-muted-foreground">{e.groupNo}</span>
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold">{e.title}</span>
                    {e.state === "pending" ? <Pill tone="default">未開始</Pill> : e.state === "staged" ? <Pill tone="info">草稿</Pill> : <Pill tone="success">已送出</Pill>}
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
          <TintCard tint="mint" title="可認領產學組" description={`全體 ${claimable.length} 組・先按先得`} action={{ href: `${base}/groups`, label: "全部" }} illustration={<Spot icon={<IconHandGrab className="size-9" strokeWidth={1.5} />} size={72} />}>
            <ul className="px-3 pt-2 pb-3">
              {claimable.map((g) => (
                <li key={g.id} className="flex min-h-11 items-center gap-3 rounded-xl px-2 py-2"><span className="tabular shrink-0 text-xs font-semibold text-muted-foreground">{g.no}</span><span className="min-w-0 flex-1 truncate text-sm font-semibold">{g.title.replace(/（產學：.*）/, "")}</span><Link href={`${base}/groups`} className={buttonVariants({ size: "sm", variant: "outline", className: "press rounded-lg bg-card" })}>認領</Link></li>
              ))}
            </ul>
          </TintCard>
        ),
      },
      {
        key: "sign", present: ready.length > 0 || waiting.length > 0,
        node: (
          <TintCard tint="lilac" title="同意書" description={`待我同意 ${ready.length} 組・等待學生 ${waiting.length} 組`} action={{ href: `${base}/signoff`, label: "進度" }} illustration={<Spot icon={<IconSignature className="size-9" strokeWidth={1.5} />} size={72} />}>
            <ul className="px-3 pt-2 pb-3">
              {ready.map((s) => (
                <li key={s.groupId} className="flex min-h-11 items-center gap-3 rounded-xl px-2 py-2"><span className="tabular shrink-0 text-xs font-semibold text-muted-foreground">{s.groupNo}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{SIGNOFF.title}</span><span className="tabular block text-xs text-muted-foreground">學生 {s.students}/{s.total} 已同意・輪到你</span></span><Link href={`${base}/signoff`} className={buttonVariants({ size: "sm", variant: "outline", className: "press rounded-lg bg-card" })}>去簽核</Link></li>
              ))}
              {waiting.map((s) => (
                <li key={s.groupId} className="flex min-h-11 items-center gap-3 rounded-xl px-2 py-2"><span className="tabular shrink-0 text-xs font-semibold text-muted-foreground">{s.groupNo}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">等待學生 {s.total - s.students} 人</span><span className="block truncate text-xs text-muted-foreground">還沒同意：{s.missing.join("、")}</span></span></li>
              ))}
            </ul>
          </TintCard>
        ),
      },
      {
        key: "groups", present: myGroups.length > 0,
        node: (
          <Panel title="指導組別" description={`我的 ${myGroups.length} 組`} action={{ href: `${base}/groups`, label: "總覽" }} className="h-full">
            <ul className="flex flex-col px-5 pb-4">
              {myGroups.map((g) => (
                <li key={g.id} className="flex min-h-11 items-center gap-3 border-t border-border/70 py-2.5 text-sm first:border-t-0">
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
          <Panel title="合作案" description={`我的 ${myCases.length} 件`} action={{ href: `${base}/industry`, label: "管理" }} className="h-full">
            <ul className="px-5 pb-3">
              {myCases.map((c) => (
                <li key={c.id} className="flex min-h-11 items-center gap-3 border-t border-border/70 py-2.5 first:border-t-0"><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{c.company}</span><span className="block truncate text-xs text-muted-foreground">{c.title}</span></span>{c.status === "claimed" ? <Pill tone="default">已有 {c.linkedGroups} 組</Pill> : <Pill tone="brand">尚未指派</Pill>}</li>
              ))}
            </ul>
            <p className="tabular border-t border-border/70 px-5 py-3 text-xs text-muted-foreground">全體尚未指派組別 {openAll} 件・<Link href={`${base}/industry?scope=all`} className="font-semibold text-foreground underline-offset-2 hover:underline">看全部</Link></p>
          </Panel>
        ),
      },
    ],
  };
}
