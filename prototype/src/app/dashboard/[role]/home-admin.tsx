import Link from "next/link";
import { IconCalendarDue, IconChecklist, IconPencilPlus, IconSignature, IconTrophy, IconUserCheck } from "@tabler/icons-react";
import { buttonVariants } from "@/components/ui/button";
import { Panel, Pill } from "@/components/dashboard/primitives";
import { Donut, StackedRows } from "@/components/dashboard/rc-charts";
import { Spot, type HomeModel } from "@/components/dashboard/home-widgets";
import { NewItemDialog } from "@/components/dashboard/new-item-dialog";
import { ADMIN_STATS, CURRENT_USERS, GRADING_PROGRESS, GROUPS, INDUSTRY, MANAGED_ITEMS, NEWS, SIGNOFF_PROGRESS, currentStage, type Role } from "@/lib/fixtures";

export function adminHome(role: Role): HomeModel {
  const base = `/dashboard/${role}`;
  const s = ADMIN_STATS;
  const stage = currentStage();
  const items = MANAGED_ITEMS.filter((i) => i.progress);
  const overdueGroups = items.reduce((a, i) => a + (i.progress?.overdue ?? 0), 0);
  const unassignedIndustry = INDUSTRY.filter((i) => i.status !== "claimed");
  const totalStudents = GROUPS.reduce((a, g) => a + g.members.length, 0);
  const gradingAssigned = GRADING_PROGRESS.reduce((a, t) => a + t.assigned, 0);
  const gradingSubmitted = GRADING_PROGRESS.reduce((a, t) => a + t.submitted, 0);
  const missingTeachers = GRADING_PROGRESS.filter((t) => t.submitted < t.assigned).length;
  const signComplete = SIGNOFF_PROGRESS.filter((p) => p.state === "complete").length;
  const signWaitTeacher = SIGNOFF_PROGRESS.filter((p) => p.students === p.total && !p.teacher).length;
  const todo = s.pendingAccounts + overdueGroups + missingTeachers + unassignedIndustry.length;
  const industryGroups = GROUPS.filter((g) => g.type === "INDUSTRY").length;

  return {
    role,
    layout: "admin",
    name: CURRENT_USERS.admin.name,
    line: `現在是「${stage.title}」。今天有 ${todo} 件事要處理；本屆 ${GROUPS.length} 組、${totalStudents} 位學生。`,
    cta: { href: `${base}/accounts?status=pending`, label: "處理待辦" },
    heroIllustration: <Spot icon={<IconTrophy className="size-20" strokeWidth={1.4} />} size={168} className="tint tint-sand" />,
    /* Roy 2026-09-10 選畫布 A（NextAdmin 分析型）：四磚 → 大圖＋甜甜圈 → 表格＋我發的公告 */
    stats: [
      { key: "accounts", label: "待審核帳號", icon: <IconUserCheck />, value: s.pendingAccounts, unit: "筆", hint: "本週新增 3 筆", tone: "brand", href: `${base}/accounts?status=pending` },
      { key: "overdue", label: "逾期組別", icon: <IconCalendarDue />, value: overdueGroups, unit: "組", hint: "系統驗收簡報", tone: overdueGroups ? "danger" : "default", href: `${base}/affairs/mi-011` },
      { key: "grading", label: "評分完成率", icon: <IconChecklist />, value: `${Math.round((gradingSubmitted / gradingAssigned) * 100)}%`, hint: `${gradingSubmitted}／${gradingAssigned} 份・${missingTeachers} 位缺評`, href: `${base}/grading` },
      { key: "sign", label: "簽核完成", icon: <IconSignature />, value: `${signComplete}／${GROUPS.length}`, unit: "組", hint: `${signWaitTeacher} 組等老師`, href: `${base}/signoff` },
    ],
    modules: [
      {
        key: "intake", present: true, span: 2,
        node: (
          <Panel title="各收件項目完成率" description="點一條看未繳組別並催繳" action={{ href: `${base}/affairs`, label: "工作台" }} className="h-full">
            <div className="px-5 pb-5"><StackedRows rows={items.map((i) => ({ label: i.title, done: i.progress!.done, overdue: i.progress!.overdue, total: i.progress!.total, href: `${base}/affairs/${i.id}` }))} /></div>
          </Panel>
        ),
      },
      {
        key: "groups", present: true,
        node: (
          <Panel title="本屆分組" description={`${GROUPS.length} 組・${totalStudents} 人・${s.ungroupedStudents} 位未分組`} action={{ href: `${base}/groups`, label: "總覽" }} className="h-full">
            <div className="flex items-center gap-5 px-5 pt-1 pb-5">
              <Donut size={132} thickness={18} data={[{ name: "一般專題", value: GROUPS.length - industryGroups, color: "var(--primary)" }, { name: "產學合作", value: industryGroups, color: "var(--brand)" }]} center={<span className="text-center"><span className="tabular block text-[24px] font-extrabold leading-none">{GROUPS.length}</span><span className="text-[10px] text-muted-foreground">組</span></span>} />
              <ul className="flex flex-1 flex-col gap-2 text-sm">
                <li className="flex items-center justify-between"><span className="inline-flex items-center gap-2"><span className="size-2.5 rounded-sm bg-primary" />一般專題</span><b className="tabular">{GROUPS.length - industryGroups}</b></li>
                <li className="flex items-center justify-between"><span className="inline-flex items-center gap-2"><span className="size-2.5 rounded-sm bg-brand" />產學合作</span><b className="tabular">{industryGroups}</b></li>
                <li className="flex items-center justify-between text-muted-foreground"><span>產學未指派</span><b className="tabular">{unassignedIndustry.length}</b></li>
                <li className="flex items-center justify-between text-muted-foreground"><span>例外組別</span><b className="tabular">{s.groupExceptions}</b></li>
              </ul>
            </div>
          </Panel>
        ),
      },
      {
        key: "teachers", present: true, span: 2,
        node: (
          <Panel title="老師評分進度" description="系統驗收" action={{ href: `${base}/grading`, label: "成績" }} className="h-full">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] text-muted-foreground"><th className="px-5 py-2 font-semibold">老師</th><th className="px-3 py-2 font-semibold">進度</th><th className="px-3 py-2 font-semibold">送出</th><th className="px-5 py-2"></th></tr></thead>
              <tbody>
                {GRADING_PROGRESS.map((t) => (
                  <tr key={t.teacher} className="border-t border-border/70">
                    <td className="px-5 py-2.5 font-semibold">{t.teacher}</td>
                    <td className="px-3 py-2.5"><div className="h-2.5 w-32 overflow-hidden rounded-full bg-muted"><span className={`block h-full rounded-full ${t.submitted === t.assigned ? "bg-success" : "bg-primary"}`} style={{ width: `${(t.submitted / t.assigned) * 100}%` }} /></div></td>
                    <td className="tabular px-3 py-2.5">{t.submitted}／{t.assigned}</td>
                    <td className="px-5 py-2.5 text-right">{t.submitted === t.assigned ? <Pill tone="success">完成</Pill> : <button type="button" className={buttonVariants({ size: "sm", variant: "outline", className: "press rounded-lg" })}>催繳</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        ),
      },
      {
        key: "news", present: true,
        node: (
          <Panel title="我發的公告" description={`${NEWS.length} 則`} action={<NewItemDialog base={base} trigger={<span className="inline-flex cursor-pointer items-center gap-1 text-[13px] font-semibold text-brand hover:underline"><IconPencilPlus className="size-4" />發布公告</span>} />} className="h-full">
            <ul className="px-2 pb-2">
              {NEWS.slice(0, 4).map((n) => (
                <li key={n.id}>
                  <Link href={`/news/${n.id}`} className="flex items-center gap-3 rounded-xl px-3 py-2 transition-colors hover:bg-accent/60">
                    <span className="tabular w-11 shrink-0 text-[11px] font-semibold text-muted-foreground">{n.date.slice(5).replace("-", "/")}</span>
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold">{n.title}</span>
                    <span className="text-[11px] text-muted-foreground">{n.category}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        ),
      },
    ],
  };
}
