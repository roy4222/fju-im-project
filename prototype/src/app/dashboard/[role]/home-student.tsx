import { IconClipboardText, IconSchool, IconUpload } from "@tabler/icons-react";
import { Spot, type HomeModel } from "@/components/dashboard/home-widgets";
import { CURRENT_USERS, MANAGED_ITEMS, MY_GROUP, SIGNOFF, TODAY_YMD, currentStage, isSubmittedState, studentOpenItems, type Role } from "@/lib/fixtures";

/* ============================================================ 學生 */
export function studentHome(role: Role): HomeModel {
  const base = `/dashboard/${role}`;
  const stage = currentStage();
  const open = studentOpenItems();
  const next = open[0];
  const overdue = open.filter((i) => i.myState === "overdue");
  const submitted = MANAGED_ITEMS.filter((i) => isSubmittedState(i.myState));
  const confirmed = MY_GROUP.members.filter((m) => m.confirmed).length;
  const name = CURRENT_USERS.student.name;
  const approvals = SIGNOFF.studentApprovals.filter((a) => a.approved).length;
  const myPending = SIGNOFF.studentApprovals.some((a) => a.name === name && !a.approved);
  return {
    role,
    layout: "student",
    name,
    line: open.length ? `現在是「${stage.title}」。作業區還有 ${open.length} 件沒送出${overdue.length ? `，其中 ${overdue.length} 件已逾期` : ""}。` : `現在是「${stage.title}」。作業區沒有待繳的東西。`,
    /* 下一步＝最近截止那件（studentOpenItems 已依截止排序）；有下一步就不再放泛用的「去作業區」 */
    next: next ? { title: next.title, due: next.dueAt ?? TODAY_YMD, href: `${base}/affairs/${next.id}`, label: next.myState === "draft" ? "繼續填寫" : "去繳交" } : undefined,
    heroIllustration: <Spot icon={<IconSchool className="size-16" strokeWidth={1.4} />} />,
    /* Roy 2026-09-10：作業區／我的組別／同意書不再各占一張卡，縮成歡迎色塊底部三格 */
    chips: [
      { label: "作業待繳", value: `${open.length} 件`, href: `${base}/affairs?tab=open`, hot: open.length > 0 },
      { label: "組員確認", value: `${confirmed}/5`, href: `${base}/groups` },
      { label: "同意書", value: myPending ? "等你同意" : `${approvals}/5`, href: `${base}/signoff` },
    ],
    stats: [
      { key: "open", label: "待繳", icon: <IconClipboardText />, value: open.length, unit: "件", tone: open.length ? "brand" : "default", href: `${base}/affairs?tab=open` },
      { key: "done", label: "已繳交", icon: <IconUpload />, value: submitted.length, unit: "件", href: `${base}/affairs?tab=done` },
    ],
    modules: [],
  };
}
